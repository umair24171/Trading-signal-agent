import dotenv from 'dotenv';
import { MarketDataService } from './services/MarketDataService.js';
import { SignalEngine } from './engine/SignalEngine.js';
import { TelegramService } from './services/TelegramService.js';
import { MT5Bridge } from './services/MT5Bridge.js';
import http from 'http';

// Add this simple server to keep Render happy
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ 
    status: 'running', 
    agent: 'Trading Signal Agent',
    uptime: process.uptime()
  }));
}).listen(PORT, () => {
  console.log(`🌐 Health server running on port ${PORT}`);
});

dotenv.config();

console.log(`
╔══════════════════════════════════════════════════════════════╗
║           TRADING SIGNAL AGENT - STARTING UP                 ║
║                                                              ║
║  Watchlist: ${process.env.WATCHLIST.padEnd(43)}║
║  Timeframe: ${process.env.TIMEFRAME.padEnd(43)}║
║  MT5 Auto-Execute: ${(process.env.MT5_ENABLED === 'true' ? 'ON' : 'OFF').padEnd(36)}║
╚══════════════════════════════════════════════════════════════╝
`);

class TradingAgent {
  constructor() {
    this.watchlist = process.env.WATCHLIST.split(',').map(s => s.trim());
    this.timeframe = process.env.TIMEFRAME || '5m';
    this.minConfidence = parseInt(process.env.MIN_CONFIDENCE) || 65;
    
    this.marketData = new MarketDataService(this.watchlist, this.timeframe);
    this.signalEngine = new SignalEngine();
    this.telegram = new TelegramService();
    this.mt5 = new MT5Bridge();
    
    this.lastSignals = new Map(); // Prevent spam
  }

  async start() {
    console.log('🚀 Agent starting...\n');

    // Send startup message
    await this.telegram.sendMessage(`
🤖 *Trading Agent Started*

📊 Watching: ${this.watchlist.join(', ')}
⏱ Timeframe: ${this.timeframe}
🎯 Min Confidence: ${this.minConfidence}%
🔄 MT5 Auto-Execute: ${process.env.MT5_ENABLED === 'true' ? 'ON ✅' : 'OFF ❌'}

_Scanning for opportunities..._
    `);

    // Wire up events
    this.marketData.on('candle', (candle) => {
      this.processCandle(candle);
    });

    this.marketData.on('error', (err) => {
      console.error('❌ Market data error:', err.message);
    });

    // Start market data feed
    await this.marketData.start();
    
    console.log('✅ Agent running - waiting for signals...\n');
  }

  async processCandle(candle) {
    // Add candle to signal engine
    this.signalEngine.addCandle(candle);

    // Generate signal
    const signal = this.signalEngine.analyze(candle.symbol);
    
    // Debug mode - show what's happening
    if (process.env.DEBUG_MODE === 'true' && signal) {
      console.log(`\n📊 [${candle.symbol}] Analysis:`);
      console.log(`   Price: ${candle.close}`);
      console.log(`   Action: ${signal.action} | Confidence: ${signal.confidence}%`);
      console.log(`   Reasons: ${signal.reasons.slice(0, 3).join(', ')}`);
      console.log(`   RSI: ${signal.indicators.rsi} | ADX: ${signal.indicators.adx}`);
      if (signal.action === 'HOLD') console.log(`   ⏸️  HOLD - No clear direction`);
      else if (signal.confidence < this.minConfidence) console.log(`   ⚠️  Confidence too low (need ${this.minConfidence}%)`);
      else console.log(`   ✅ SIGNAL WILL BE SENT!`);
    }
    
    if (!signal) return;
    if (signal.action === 'HOLD') return;
    if (signal.confidence < this.minConfidence) return;

    // Check cooldown (no duplicate signals within 30 mins)
    const lastSignal = this.lastSignals.get(candle.symbol);
    if (lastSignal) {
      const timeDiff = Date.now() - lastSignal.timestamp;
      if (timeDiff < 30 * 60 * 1000 && lastSignal.action === signal.action) {
        return; // Skip duplicate
      }
    }

    // Log signal
    console.log(`\n🎯 SIGNAL: ${signal.action} ${candle.symbol} @ ${candle.close} (${signal.confidence}% confidence)`);
    console.log(`   Reasons: ${signal.reasons.join(', ')}`);

    // Send to Telegram
    await this.telegram.sendSignal(signal);

    // Execute on MT5 if enabled
    if (process.env.MT5_ENABLED === 'true') {
      await this.mt5.executeSignal(signal);
    }

    // Update last signal
    this.lastSignals.set(candle.symbol, {
      action: signal.action,
      timestamp: Date.now()
    });
  }
}

// Start the agent
const agent = new TradingAgent();
agent.start().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down...');
  process.exit(0);
});
