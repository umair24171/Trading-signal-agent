import { EventEmitter } from 'events';
import axios from 'axios';

export class MarketDataService extends EventEmitter {
  constructor(symbols, timeframe) {
    super();
    this.symbols = symbols;
    this.timeframe = this.normalizeTimeframe(timeframe);
    this.apiKey = process.env.TWELVE_DATA_API_KEY;
    this.candleBuffers = new Map();
    this.pollInterval = null;
    
    // ── RATE LIMIT MANAGEMENT ──
    // TwelveData free: 800 credits/day, 8 credits/minute
    this.apiCreditsUsed = 0;
    this.apiCreditsDaily = 0;
    this.dailyLimit = parseInt(process.env.API_DAILY_LIMIT) || 750; // Leave buffer
    this.minuteLimit = 7; // Leave 1 buffer
    this.minuteCallCount = 0;
    this.lastMinuteReset = Date.now();
    
    // Track last candle timestamps to avoid unnecessary API calls
    this.lastCandleTimestamps = new Map();
    
    // Retry config
    this.maxRetries = 3;
    this.retryDelay = 5000;
    
    // Connection monitoring
    this.consecutiveErrors = 0;
    this.maxConsecutiveErrors = 10;
    this.isHealthy = true;
    
    // Reset daily counter at midnight UTC
    this.scheduleDailyReset();
  }

  normalizeTimeframe(tf) {
    const conversions = {
      '1m': '1min', '5m': '5min', '15m': '15min', '30m': '30min',
      '1h': '1h', '4h': '4h', '1d': '1day',
      '1min': '1min', '5min': '5min', '15min': '15min', '30min': '30min',
      '45min': '45min', '2h': '2h', '8h': '8h', '1day': '1day',
      '1week': '1week', '1month': '1month'
    };
    const normalized = conversions[tf] || tf;
    console.log(`⏱️ Timeframe: ${tf} → ${normalized}`);
    return normalized;
  }

  async start() {
    console.log(`📡 Connecting to market data for: ${this.symbols.join(', ')}`);
    console.log(`📊 API Credit Management: ${this.dailyLimit}/day limit, ${this.minuteLimit}/min limit`);
    await this.fetchHistoricalData();
    await this.startPolling();
  }

  async startPolling() {
    const intervalMs = this.getSmartInterval();
    console.log(`⏱ Smart polling every ${intervalMs / 1000} seconds`);
    console.log(`   (Optimized for ${this.symbols.length} symbols on ${this.timeframe} timeframe)`);
    console.log(`   Estimated daily API calls: ~${this.estimateDailyCalls(intervalMs)}\n`);

    // First fetch
    console.log('🔍 Fetching first real-time data...\n');
    await this.fetchLatestCandles();

    this.pollInterval = setInterval(() => {
      this.fetchLatestCandles();
    }, intervalMs);
  }

  // ── SMART INTERVAL: Calculate optimal polling based on timeframe and symbols ──
  getSmartInterval() {
    const baseInterval = this.getIntervalMs();
    const symbolCount = this.symbols.length;
    
    // Calculate calls per day at this interval
    const callsPerPoll = symbolCount;
    const pollsPerDay = (24 * 60 * 60 * 1000) / baseInterval;
    const estimatedDaily = pollsPerDay * callsPerPoll;
    
    // If we'd exceed daily limit, increase interval
    if (estimatedDaily > this.dailyLimit * 0.9) {
      const safeInterval = Math.ceil((24 * 60 * 60 * 1000 * callsPerPoll) / (this.dailyLimit * 0.8));
      console.log(`⚠️ Adjusted polling interval to stay within API limits`);
      return Math.max(safeInterval, baseInterval);
    }
    
    // For short timeframes, don't poll faster than the candle closes
    // No point polling every 60s for 5min candles - new candle only every 5 min
    return baseInterval;
  }

  estimateDailyCalls(intervalMs) {
    const pollsPerDay = (24 * 60 * 60 * 1000) / intervalMs;
    return Math.round(pollsPerDay * this.symbols.length);
  }

  // ── RATE LIMIT CHECK ──
  async checkRateLimit() {
    // Reset minute counter
    if (Date.now() - this.lastMinuteReset > 60000) {
      this.minuteCallCount = 0;
      this.lastMinuteReset = Date.now();
    }

    // Check minute limit
    if (this.minuteCallCount >= this.minuteLimit) {
      const waitTime = 60000 - (Date.now() - this.lastMinuteReset) + 1000;
      console.log(`⏳ Rate limit: waiting ${(waitTime/1000).toFixed(0)}s for minute reset...`);
      await this.sleep(waitTime);
      this.minuteCallCount = 0;
      this.lastMinuteReset = Date.now();
    }

    // Check daily limit
    if (this.apiCreditsDaily >= this.dailyLimit) {
      console.log(`🛑 Daily API limit reached (${this.apiCreditsDaily}/${this.dailyLimit}). Pausing until midnight UTC...`);
      this.emit('dailyLimitReached');
      return false;
    }

    return true;
  }

  // ── API CALL WITH RETRY AND RATE LIMITING ──
  async apiCall(params, retries = 0) {
    if (!(await this.checkRateLimit())) return null;

    try {
      this.minuteCallCount++;
      this.apiCreditsDaily++;
      
      const response = await axios.get('https://api.twelvedata.com/time_series', {
        params: { ...params, apikey: this.apiKey },
        timeout: 15000
      });

      // Check for API errors
      if (response.data.status === 'error') {
        const msg = response.data.message || '';
        
        // Rate limit error
        if (msg.includes('limit') || msg.includes('exceeded') || msg.includes('429')) {
          console.warn(`⚠️ API rate limit hit. Waiting 60s...`);
          await this.sleep(60000);
          this.minuteCallCount = 0;
          if (retries < this.maxRetries) {
            return this.apiCall(params, retries + 1);
          }
        }
        
        console.error(`❌ API Error: ${msg}`);
        return null;
      }

      // Success - reset error counter
      this.consecutiveErrors = 0;
      this.isHealthy = true;
      return response.data;

    } catch (err) {
      this.consecutiveErrors++;
      
      if (err.response?.status === 429) {
        console.warn(`⚠️ HTTP 429 Rate limited. Waiting 60s...`);
        await this.sleep(60000);
        if (retries < this.maxRetries) return this.apiCall(params, retries + 1);
      } else if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
        console.warn(`⚠️ Request timeout. Retrying...`);
        if (retries < this.maxRetries) {
          await this.sleep(this.retryDelay * (retries + 1));
          return this.apiCall(params, retries + 1);
        }
      } else {
        console.error(`❌ API Error: ${err.message}`);
      }

      // Health check
      if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
        this.isHealthy = false;
        console.error(`🚨 ${this.consecutiveErrors} consecutive errors! Service may be down.`);
        this.emit('unhealthy', this.consecutiveErrors);
      }

      return null;
    }
  }

  async fetchHistoricalData() {
    console.log('\n📥 Fetching historical data...');
    
    for (const symbol of this.symbols) {
      console.log(`   Fetching ${symbol}...`);
      
      const data = await this.apiCall({
        symbol,
        interval: this.timeframe,
        outputsize: 150 // More data for better indicator warmup
      });

      if (data?.values) {
        const candles = data.values.reverse().map(v => ({
          symbol,
          timestamp: new Date(v.datetime).getTime(),
          open: parseFloat(v.open),
          high: parseFloat(v.high),
          low: parseFloat(v.low),
          close: parseFloat(v.close),
          volume: parseFloat(v.volume || 0)
        }));

        this.candleBuffers.set(symbol, candles);
        this.lastCandleTimestamps.set(symbol, candles[candles.length - 1].timestamp);
        console.log(`   ✅ Loaded ${candles.length} candles for ${symbol} (Price: ${candles[candles.length - 1].close})`);
      } else {
        console.error(`   ❌ No data for ${symbol}`);
      }

      await this.sleep(2000); // Generous spacing between initial fetches
    }
    
    console.log(`📥 Historical data complete (API credits used: ${this.apiCreditsDaily})\n`);
  }

  async fetchLatestCandles() {
    if (!this.isHealthy) {
      console.log('⚠️ Service unhealthy, attempting recovery...');
      this.consecutiveErrors = 0;
      this.isHealthy = true;
    }

    for (const symbol of this.symbols) {
      const data = await this.apiCall({
        symbol,
        interval: this.timeframe,
        outputsize: 3 // Get last 3 candles for safety
      });

      if (!data?.values) continue;

      // Process latest candles
      for (const v of data.values.reverse()) {
        const candle = {
          symbol,
          timestamp: new Date(v.datetime).getTime(),
          open: parseFloat(v.open),
          high: parseFloat(v.high),
          low: parseFloat(v.low),
          close: parseFloat(v.close),
          volume: parseFloat(v.volume || 0)
        };

        const buffer = this.candleBuffers.get(symbol) || [];
        const lastCandle = buffer[buffer.length - 1];

        if (!lastCandle || candle.timestamp > lastCandle.timestamp) {
          // New candle
          buffer.push(candle);
          if (buffer.length > 300) buffer.shift();
          this.candleBuffers.set(symbol, buffer);
          this.lastCandleTimestamps.set(symbol, candle.timestamp);
          
          console.log(`📊 New candle: ${symbol} @ ${candle.close} (${new Date(candle.timestamp).toISOString()})`);
          this.emit('candle', candle);
        } else if (candle.timestamp === lastCandle.timestamp) {
          // Update current candle
          buffer[buffer.length - 1] = candle;
          if (process.env.DEBUG_MODE === 'true') {
            console.log(`🔄 Updated: ${symbol} @ ${candle.close}`);
          }
          this.emit('candle', candle);
        }
      }

      await this.sleep(800); // Rate limit between symbols
    }

    // Log API usage periodically
    if (this.apiCreditsDaily % 50 === 0 && this.apiCreditsDaily > 0) {
      console.log(`📊 API Credits: ${this.apiCreditsDaily}/${this.dailyLimit} used today`);
    }
  }

  getCandles(symbol) {
    return this.candleBuffers.get(symbol) || [];
  }

  getIntervalMs() {
    const map = {
      '1min': 65000,     // Slightly over 1 min to ensure new candle
      '5min': 305000,    // Slightly over 5 min
      '15min': 910000,
      '30min': 1810000,
      '45min': 2710000,
      '1h': 3610000,
      '2h': 7210000,
      '4h': 14410000,
      '1day': 3600000,   // Check hourly for daily candles
    };
    return map[this.timeframe] || 305000;
  }

  scheduleDailyReset() {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(0, 1, 0, 0); // Reset at 00:01 UTC
    
    const msUntilReset = tomorrow.getTime() - now.getTime();
    
    setTimeout(() => {
      this.apiCreditsDaily = 0;
      console.log('🔄 Daily API credit counter reset');
      this.scheduleDailyReset(); // Schedule next reset
    }, msUntilReset);
    
    console.log(`⏰ Daily credit reset scheduled in ${(msUntilReset / 3600000).toFixed(1)} hours`);
  }

  getHealthStatus() {
    return {
      isHealthy: this.isHealthy,
      consecutiveErrors: this.consecutiveErrors,
      apiCreditsUsedToday: this.apiCreditsDaily,
      apiCreditsRemaining: this.dailyLimit - this.apiCreditsDaily,
      symbolsTracking: this.symbols.length,
      candleBufferSizes: Object.fromEntries(
        this.symbols.map(s => [s, (this.candleBuffers.get(s) || []).length])
      )
    };
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  stop() {
    if (this.pollInterval) clearInterval(this.pollInterval);
  }
}