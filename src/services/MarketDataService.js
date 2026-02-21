import { EventEmitter } from 'events';
import axios from 'axios';

export class MarketDataService extends EventEmitter {
  constructor(symbols, timeframe) {
    super();
    this.symbols = symbols;
    this.timeframe = this.normalizeTimeframe(timeframe);
    this.apiKey = process.env.TWELVE_DATA_API_KEY;
    this.candleBuffers = new Map();

    // 15min secondary timeframe buffer
    this.candleBuffers15m = new Map();
    this.lastCandle15mTimestamps = new Map();

    // 1h macro timeframe buffer
    this.candleBuffers1h = new Map();
    this.lastCandle1hTimestamps = new Map();

    this.pollInterval = null;
    this.poll15mInterval = null;
    this.poll1hInterval = null;

    // ── RATE LIMIT MANAGEMENT ──
    this.apiCreditsUsed = 0;
    this.apiCreditsDaily = 0;
    this.dailyLimit = parseInt(process.env.API_DAILY_LIMIT) || 750;
    this.minuteLimit = 7;
    this.minuteCallCount = 0;
    this.lastMinuteReset = Date.now();

    this.lastCandleTimestamps = new Map();

    this.maxRetries = 3;
    this.retryDelay = 5000;

    this.consecutiveErrors = 0;
    this.maxConsecutiveErrors = 10;
    this.isHealthy = true;

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

  // ── FETCH 1H HISTORICAL FOR MACRO TREND ──
  async fetchHistorical1h(symbol) {
    try {
      console.log(`   Fetching ${symbol} (1h macro)...`);
      const data = await this.apiCall({
        symbol,
        interval: '1h',
        outputsize: 200
      });

      if (!data?.values) {
        console.warn(`   ⚠️ No 1h data for ${symbol}`);
        return [];
      }

      const candles = this._parseCandles(symbol, data.values);
      this.candleBuffers1h.set(symbol, candles);
      this.lastCandle1hTimestamps.set(symbol, candles[candles.length - 1].timestamp);
      console.log(`   ✅ 1h: ${candles.length} candles for ${symbol} (Macro loaded)`);
      return candles;
    } catch (err) {
      console.error(`   ❌ 1h fetch error for ${symbol}:`, err.message);
      return [];
    }
  }

  async start() {
    console.log(`📡 Connecting to market data for: ${this.symbols.join(', ')}`);
    console.log(`📊 API Credit Management: ${this.dailyLimit}/day limit, ${this.minuteLimit}/min limit`);
    await this.fetchHistoricalData();
    await this.startPolling();
  }

  async startPolling() {
    const intervalMs = this.getSmartInterval();
    console.log(`⏱ Smart polling every ${intervalMs / 1000} seconds (5min)`);
    console.log(`⏱ 15min polling every 910 seconds`);
    console.log(`⏱ 1h macro polling every 3600 seconds`);
    console.log(`   Estimated daily API calls: ~${this.estimateDailyCalls(intervalMs)} (5min) + ~${this.estimateDailyCalls(910000)} (15min) + ~${this.estimateDailyCalls(3600000)} (1h)\n`);

    // First fetch
    console.log('🔍 Fetching first real-time data...\n');
    await this.fetchLatestCandles();
    await this.fetchLatest15mCandles();
    await this.fetchLatest1hCandles();

    this.pollInterval = setInterval(() => {
      this.fetchLatestCandles();
    }, intervalMs);

    // Poll 15min candles every ~15min (910s)
    this.poll15mInterval = setInterval(() => {
      this.fetchLatest15mCandles();
    }, 910000);

    // Poll 1h candles every hour (3605s)
    this.poll1hInterval = setInterval(() => {
      this.fetchLatest1hCandles();
    }, 3605000);
  }

  getSmartInterval() {
    const baseInterval = this.getIntervalMs();
    const symbolCount = this.symbols.length;
    const callsPerPoll = symbolCount;
    const pollsPerDay = (24 * 60 * 60 * 1000) / baseInterval;
    const estimatedDaily = pollsPerDay * callsPerPoll;

    if (estimatedDaily > this.dailyLimit * 0.9) {
      const safeInterval = Math.ceil((24 * 60 * 60 * 1000 * callsPerPoll) / (this.dailyLimit * 0.8));
      console.log(`⚠️ Adjusted polling interval to stay within API limits`);
      return Math.max(safeInterval, baseInterval);
    }

    return baseInterval;
  }

  estimateDailyCalls(intervalMs) {
    const pollsPerDay = (24 * 60 * 60 * 1000) / intervalMs;
    return Math.round(pollsPerDay * this.symbols.length);
  }

  async checkRateLimit() {
    if (Date.now() - this.lastMinuteReset > 60000) {
      this.minuteCallCount = 0;
      this.lastMinuteReset = Date.now();
    }

    if (this.minuteCallCount >= this.minuteLimit) {
      const waitTime = 60000 - (Date.now() - this.lastMinuteReset) + 1000;
      console.log(`⏳ Rate limit: waiting ${(waitTime / 1000).toFixed(0)}s for minute reset...`);
      await this.sleep(waitTime);
      this.minuteCallCount = 0;
      this.lastMinuteReset = Date.now();
    }

    if (this.apiCreditsDaily >= this.dailyLimit) {
      console.log(`🛑 Daily API limit reached (${this.apiCreditsDaily}/${this.dailyLimit}). Pausing until midnight UTC...`);
      this.emit('dailyLimitReached');
      return false;
    }

    return true;
  }

  async apiCall(params, retries = 0) {
    if (!(await this.checkRateLimit())) return null;

    try {
      this.minuteCallCount++;
      this.apiCreditsDaily++;

      const response = await axios.get('https://api.twelvedata.com/time_series', {
        params: { ...params, apikey: this.apiKey },
        timeout: 15000
      });

      if (response.data.status === 'error') {
        const msg = response.data.message || '';
        if (msg.includes('limit') || msg.includes('exceeded') || msg.includes('429')) {
          console.warn(`⚠️ API rate limit hit. Waiting 60s...`);
          await this.sleep(60000);
          this.minuteCallCount = 0;
          if (retries < this.maxRetries) return this.apiCall(params, retries + 1);
        }
        console.error(`❌ API Error: ${msg}`);
        return null;
      }

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

      if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
        this.isHealthy = false;
        console.error(`🚨 ${this.consecutiveErrors} consecutive errors! Service may be down.`);
        this.emit('unhealthy', this.consecutiveErrors);
      }

      return null;
    }
  }

  async fetchHistoricalData() {
    console.log('\n📥 Fetching historical data (5min + 15min)...');

    for (const symbol of this.symbols) {
      // ── 5min historical ──
      console.log(`   Fetching ${symbol} (5min)...`);
      const data = await this.apiCall({
        symbol,
        interval: this.timeframe,
        outputsize: 150
      });

      if (data?.values) {
        const candles = this._parseCandles(symbol, data.values);
        this.candleBuffers.set(symbol, candles);
        this.lastCandleTimestamps.set(symbol, candles[candles.length - 1].timestamp);
        console.log(`   ✅ 5min: ${candles.length} candles for ${symbol} (Price: ${candles[candles.length - 1].close})`);
      } else {
        console.error(`   ❌ No 5min data for ${symbol}`);
      }

      await this.sleep(1500);

      // ── 15min historical ──
      console.log(`   Fetching ${symbol} (15min)...`);
      const data15m = await this.apiCall({
        symbol,
        interval: '15min',
        outputsize: 150
      });

      if (data15m?.values) {
        const candles15m = this._parseCandles(symbol, data15m.values);
        this.candleBuffers15m.set(symbol, candles15m);
        this.lastCandle15mTimestamps.set(symbol, candles15m[candles15m.length - 1].timestamp);
        console.log(`   ✅ 15min: ${candles15m.length} candles for ${symbol}`);
        this.emit('candles15mLoaded', symbol, candles15m);
      } else {
        console.error(`   ❌ No 15min data for ${symbol}`);
      }

      await this.sleep(1500);
    }

    console.log(`📥 Historical data complete (API credits used: ${this.apiCreditsDaily})\n`);
  }

  // ── FETCH LATEST 1H CANDLES (live polling) ──
  async fetchLatest1hCandles() {
    if (!this.isHealthy) return;

    for (const symbol of this.symbols) {
      const data = await this.apiCall({
        symbol,
        interval: '1h',
        outputsize: 3
      });

      if (!data?.values) continue;

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

        const buffer = this.candleBuffers1h.get(symbol) || [];
        const lastCandle = buffer[buffer.length - 1];

        if (!lastCandle || candle.timestamp > lastCandle.timestamp) {
          buffer.push(candle);
          if (buffer.length > 300) buffer.shift();
          this.candleBuffers1h.set(symbol, buffer);
          this.lastCandle1hTimestamps.set(symbol, candle.timestamp);
          this.emit('candle1h', candle);
        } else if (candle.timestamp === lastCandle.timestamp) {
          buffer[buffer.length - 1] = candle;
          this.candleBuffers1h.set(symbol, buffer);
          this.emit('candle1h', candle);
        }
      }

      await this.sleep(800);
    }
  }

  // ── FETCH LATEST 15MIN CANDLES ──
  async fetchLatest15mCandles() {
    if (!this.isHealthy) return;

    for (const symbol of this.symbols) {
      const data = await this.apiCall({
        symbol,
        interval: '15min',
        outputsize: 3
      });

      if (!data?.values) continue;

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

        const buffer = this.candleBuffers15m.get(symbol) || [];
        const lastCandle = buffer[buffer.length - 1];

        if (!lastCandle || candle.timestamp > lastCandle.timestamp) {
          buffer.push(candle);
          if (buffer.length > 300) buffer.shift();
          this.candleBuffers15m.set(symbol, buffer);
          this.lastCandle15mTimestamps.set(symbol, candle.timestamp);
          this.emit('candle15m', candle);
        } else if (candle.timestamp === lastCandle.timestamp) {
          buffer[buffer.length - 1] = candle;
          this.candleBuffers15m.set(symbol, buffer);
          this.emit('candle15m', candle);
        }
      }

      await this.sleep(800);
    }
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
        outputsize: 3
      });

      if (!data?.values) continue;

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
          buffer.push(candle);
          if (buffer.length > 300) buffer.shift();
          this.candleBuffers.set(symbol, buffer);
          this.lastCandleTimestamps.set(symbol, candle.timestamp);
          console.log(`📊 New candle: ${symbol} @ ${candle.close} (${new Date(candle.timestamp).toISOString()})`);
          this.emit('candle', candle);
        } else if (candle.timestamp === lastCandle.timestamp) {
          buffer[buffer.length - 1] = candle;
          if (process.env.DEBUG_MODE === 'true') {
            console.log(`🔄 Updated: ${symbol} @ ${candle.close}`);
          }
          this.emit('candle', candle);
        }
      }

      await this.sleep(800);
    }

    if (this.apiCreditsDaily % 50 === 0 && this.apiCreditsDaily > 0) {
      console.log(`📊 API Credits: ${this.apiCreditsDaily}/${this.dailyLimit} used today`);
    }
  }

  _parseCandles(symbol, values) {
    return values.reverse().map(v => ({
      symbol,
      timestamp: new Date(v.datetime).getTime(),
      open: parseFloat(v.open),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close),
      volume: parseFloat(v.volume || 0)
    }));
  }

  getCandles(symbol) {
    return this.candleBuffers.get(symbol) || [];
  }

  getCandles15m(symbol) {
    return this.candleBuffers15m.get(symbol) || [];
  }

  getCandles1h(symbol) {
    return this.candleBuffers1h.get(symbol) || [];
  }

  getIntervalMs() {
    const map = {
      '1min': 65000,
      '5min': 305000,
      '15min': 910000,
      '30min': 1810000,
      '45min': 2710000,
      '1h': 3610000,
      '2h': 7210000,
      '4h': 14410000,
      '1day': 3600000,
    };
    return map[this.timeframe] || 305000;
  }

  scheduleDailyReset() {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(0, 1, 0, 0);

    const msUntilReset = tomorrow.getTime() - now.getTime();

    setTimeout(() => {
      this.apiCreditsDaily = 0;
      console.log('🔄 Daily API credit counter reset');
      this.scheduleDailyReset();
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
      ),
      candleBuffer15mSizes: Object.fromEntries(
        this.symbols.map(s => [s, (this.candleBuffers15m.get(s) || []).length])
      ),
      candleBuffer1hSizes: Object.fromEntries(
        this.symbols.map(s => [s, (this.candleBuffers1h.get(s) || []).length])
      )
    };
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  stop() {
    if (this.pollInterval) clearInterval(this.pollInterval);
    if (this.poll15mInterval) clearInterval(this.poll15mInterval);
    if (this.poll1hInterval) clearInterval(this.poll1hInterval);
  }
}