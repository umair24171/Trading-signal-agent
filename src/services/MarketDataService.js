import { EventEmitter } from 'events';
import axios from 'axios';

export class MarketDataService extends EventEmitter {
  constructor(symbols, timeframe) {
    super();
    this.symbols = symbols;
    this.timeframe = this.normalizeTimeframe(timeframe); // Convert format
    this.apiKey = process.env.TWELVE_DATA_API_KEY;
    this.candleBuffers = new Map();
    this.pollInterval = null;
  }

  // Convert common formats to TwelveData format
  normalizeTimeframe(tf) {
    const conversions = {
      '1m': '1min',
      '5m': '5min',
      '15m': '15min',
      '30m': '30min',
      '1h': '1h',
      '4h': '4h',
      '1d': '1day',
      // Already correct formats
      '1min': '1min',
      '5min': '5min',
      '15min': '15min',
      '30min': '30min',
      '45min': '45min',
      '2h': '2h',
      '8h': '8h',
      '1day': '1day',
      '1week': '1week',
      '1month': '1month'
    };
    
    const normalized = conversions[tf] || tf;
    console.log(`⏱️ Timeframe: ${tf} → ${normalized}`);
    return normalized;
  }

  async start() {
    console.log(`📡 Connecting to market data for: ${this.symbols.join(', ')}`);

    // Fetch initial historical data
    await this.fetchHistoricalData();

    // Start polling for new candles
    const intervalMs = this.getIntervalMs();
    console.log(`⏱ Polling every ${intervalMs / 1000} seconds`);
    console.log(`💡 Tip: For faster testing, set TIMEFRAME=1m in .env\n`);

    // Immediately do first analysis after loading history
    console.log('🔍 Running initial analysis...\n');
    await this.fetchLatestCandles();

    this.pollInterval = setInterval(() => {
      this.fetchLatestCandles();
    }, intervalMs);
  }

  async fetchHistoricalData() {
    console.log('\n📥 Fetching historical data...');
    
    for (const symbol of this.symbols) {
      try {
        console.log(`   Fetching ${symbol}...`);
        
        const response = await axios.get('https://api.twelvedata.com/time_series', {
          params: {
            symbol: symbol,
            interval: this.timeframe,
            outputsize: 100,
            apikey: this.apiKey
          }
        });

        // Check for API errors
        if (response.data.status === 'error') {
          console.error(`   ❌ API Error for ${symbol}: ${response.data.message}`);
          continue;
        }

        if (response.data.values) {
          const candles = response.data.values.reverse().map(v => ({
            symbol,
            timestamp: new Date(v.datetime).getTime(),
            open: parseFloat(v.open),
            high: parseFloat(v.high),
            low: parseFloat(v.low),
            close: parseFloat(v.close),
            volume: parseFloat(v.volume || 0)
          }));

          this.candleBuffers.set(symbol, candles);
          console.log(`   ✅ Loaded ${candles.length} candles for ${symbol} (Price: ${candles[candles.length-1].close})`);

          // Emit historical candles for analysis warmup
          candles.forEach(c => this.emit('candle', c));
        } else {
          console.error(`   ❌ No data for ${symbol}:`, JSON.stringify(response.data).slice(0, 200));
        }
      } catch (err) {
        console.error(`   ❌ Failed to fetch ${symbol}:`, err.message);
        if (err.response) {
          console.error(`   Response:`, err.response.data);
        }
        this.emit('error', err);
      }

      // Rate limit: wait between requests
      await this.sleep(1500);
    }
    
    console.log('📥 Historical data fetch complete\n');
  }

  async fetchLatestCandles() {
    for (const symbol of this.symbols) {
      try {
        const response = await axios.get('https://api.twelvedata.com/time_series', {
          params: {
            symbol: symbol,
            interval: this.timeframe,
            outputsize: 2,
            apikey: this.apiKey
          }
        });

        // Check for API errors
        if (response.data.status === 'error') {
          console.error(`❌ API Error for ${symbol}: ${response.data.message}`);
          continue;
        }

        if (response.data.values?.[0]) {
          const v = response.data.values[0];
          const candle = {
            symbol,
            timestamp: new Date(v.datetime).getTime(),
            open: parseFloat(v.open),
            high: parseFloat(v.high),
            low: parseFloat(v.low),
            close: parseFloat(v.close),
            volume: parseFloat(v.volume || 0)
          };

          // Check if this is a new candle
          const buffer = this.candleBuffers.get(symbol) || [];
          const lastCandle = buffer[buffer.length - 1];

          if (!lastCandle || candle.timestamp > lastCandle.timestamp) {
            buffer.push(candle);
            if (buffer.length > 200) buffer.shift();
            this.candleBuffers.set(symbol, buffer);
            
            console.log(`📊 New candle: ${symbol} @ ${candle.close}`);
            this.emit('candle', candle);
          } else {
            // Update existing candle (price changed within same timeframe)
            buffer[buffer.length - 1] = candle;
            if (process.env.DEBUG_MODE === 'true') {
              console.log(`🔄 Updated: ${symbol} @ ${candle.close}`);
            }
            this.emit('candle', candle);
          }
        }
      } catch (err) {
        if (err.response?.status === 429) {
          console.warn(`⚠️ Rate limited for ${symbol}, waiting...`);
        } else {
          console.error(`❌ Error fetching ${symbol}:`, err.message);
        }
      }

      await this.sleep(500); // Rate limit between symbols
    }
  }

  getCandles(symbol) {
    return this.candleBuffers.get(symbol) || [];
  }

  getIntervalMs() {
    const map = {
      '1min': 60000,
      '5min': 300000,
      '15min': 900000,
      '30min': 1800000,
      '45min': 2700000,
      '1h': 3600000,
      '2h': 7200000,
      '4h': 14400000,
      '8h': 28800000,
      '1day': 86400000,
      // Also support shorthand
      '1m': 60000,
      '5m': 300000,
      '15m': 900000,
      '30m': 1800000,
    };
    return map[this.timeframe] || 300000;
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  stop() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }
  }
}
