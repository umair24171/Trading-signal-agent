import dotenv from 'dotenv';
dotenv.config();

import http from 'http';
import { MarketDataService } from './services/MarketDataService.js';
import { SignalEngine } from './engine/SignalEngine.js';
import { TelegramService } from './services/TelegramService.js';
import { MT5Bridge } from './services/MT5Bridge.js';

// ── HEALTH SERVER ──
const PORT = process.env.PORT || 3000;
const startTime = Date.now();
let agentInstance = null;

http.createServer((req, res) => {
  const health = agentInstance?.getHealthStatus() || {};
  
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'running',
    agent: 'Trading Signal Agent v2',
    uptime: process.uptime(),
    uptimeFormatted: formatUptime(process.uptime()),
    ...health
  }, null, 2));
}).listen(PORT, () => {
  console.log(`🌐 Health server running on port ${PORT}`);
});

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

// ── BANNER ──
console.log(`
╔══════════════════════════════════════════════════════════════╗
║         TRADING SIGNAL AGENT v2 - STARTING UP                ║
║                                                              ║
║  Watchlist: ${(process.env.WATCHLIST || '').padEnd(43)}║
║  Timeframe: ${(process.env.TIMEFRAME || '5m').padEnd(43)}║
║  Min Confidence: ${((process.env.MIN_CONFIDENCE || '60') + '%').padEnd(38)}║
║  Min Confluence: ${((process.env.MIN_CONFLUENCE || '3') + ' signals').padEnd(38)}║
║  MT5 Auto-Execute: ${(process.env.MT5_ENABLED === 'true' ? 'ON' : 'OFF').padEnd(36)}║
║                                                              ║
║  Upgrades: Confluence-based signals, Smart rate limiting,    ║
║  Market context, Session awareness, S/R detection            ║
╚══════════════════════════════════════════════════════════════╝
`);

class TradingAgent {
  constructor() {
    this.watchlist = process.env.WATCHLIST.split(',').map(s => s.trim());
    this.timeframe = process.env.TIMEFRAME || '5m';
    this.minConfidence = parseInt(process.env.MIN_CONFIDENCE) || 60;
    this.minConfluence = parseInt(process.env.MIN_CONFLUENCE) || 3;
    
    this.marketData = new MarketDataService(this.watchlist, this.timeframe);
    this.signalEngine = new SignalEngine({ minConfluence: this.minConfluence });
    this.telegram = new TelegramService();
    this.mt5 = new MT5Bridge();
    
    this.lastSignals = new Map();
    this.signalCooldown = parseInt(process.env.SIGNAL_COOLDOWN_MINS) || 15; // Minutes between same signals
    
    // Stats tracking
    this.stats = {
      signalsToday: [],
      totalAnalyses: 0,
      startTime: Date.now()
    };
  }

  async start() {
    console.log('🚀 Agent starting...\n');

    await this.telegram.sendMessage(`
🤖 *Trading Agent v2 Started*

📊 Watching: ${this.watchlist.join(', ')}
⏱ Timeframe: ${this.timeframe}
🎯 Min Confidence: ${this.minConfidence}%
🔗 Min Confluence: ${this.minConfluence} signals
🔄 MT5: ${process.env.MT5_ENABLED === 'true' ? 'ON ✅' : 'OFF ❌'}

*New Features:*
• Confluence-based signals (${this.minConfluence}+ confirming indicators)
• Market context awareness (trend, session, volatility)
• Support/Resistance detection
• Smart API rate limiting
• Daily reports

_Scanning for high-quality opportunities..._
    `);

    // Load historical data
    await this.marketData.fetchHistoricalData();

    // Warm up signal engine
    for (const symbol of this.watchlist) {
      const historicalCandles = this.marketData.getCandles(symbol);
      if (historicalCandles.length > 0) {
        this.signalEngine.loadHistoricalCandles(symbol, historicalCandles);
      }
    }
    console.log('📊 Indicators warmed up with historical data\n');

    // Wire events
    this.marketData.on('candle', (candle) => this.processCandle(candle));
    this.marketData.on('error', (err) => {
      console.error('❌ Market data error:', err.message);
      this.telegram.sendError(`Market data error: ${err.message}`).catch(() => {});
    });
    this.marketData.on('dailyLimitReached', () => {
      this.telegram.sendMessage('⚠️ *API daily limit reached.* Agent paused until midnight UTC.').catch(() => {});
    });
    this.marketData.on('unhealthy', (errors) => {
      this.telegram.sendError(`🚨 Service unhealthy: ${errors} consecutive errors`).catch(() => {});
    });

    // Start polling
    await this.marketData.startPolling();
    console.log('✅ Agent running - waiting for high-confluence signals...\n');

    // Schedule daily report
    this.scheduleDailyReport();
  }

  async processCandle(candle) {
    this.signalEngine.addCandle(candle);
    const signal = this.signalEngine.analyze(candle.symbol);
    this.stats.totalAnalyses++;

    if (!signal) return;

    // ── DEBUG MODE ──
    if (process.env.DEBUG_MODE === 'true') {
      const ctx = signal.context || {};
      console.log(`\n📊 [${candle.symbol}] Analysis #${this.stats.totalAnalyses}:`);
      console.log(`   Price: ${candle.close} | Action: ${signal.action} | Confidence: ${signal.confidence}%`);
      console.log(`   Events: ${signal.eventCount || 0} | States: ${signal.stateCount || 0} | Total: ${signal.confluenceCount} (need ${this.minConfluence})`);
      console.log(`   Context: ${ctx.trend} trend (ADX:${ctx.trendStrength?.toFixed(0) || '?'}) | ${ctx.regime} | ${ctx.session} | Vol: ${ctx.volatility}`);
      console.log(`   RSI: ${signal.indicators.rsi} | Stoch: ${signal.indicators.stochK}/${signal.indicators.stochD} | CCI: ${signal.indicators.cci}`);
      
      if (signal.reasons.length > 0) {
        console.log(`   ✅ Reasons: ${signal.reasons.slice(0, 5).join(' | ')}`);
      }
      if (signal.warnings?.length > 0) {
        console.log(`   ⚠️ ${signal.warnings.join(' | ')}`);
      }
      
      if (signal.action === 'HOLD') {
        console.log(`   ⏸️  HOLD`);
      } else if (signal.confidence < this.minConfidence) {
        console.log(`   ❌ Rejected: confidence ${signal.confidence}% < ${this.minConfidence}%`);
      } else {
        console.log(`   🎯 SIGNAL QUALIFIES! → ${signal.action} @ ${signal.confidence}%`);
      }
    }

    // ── FILTERS ──
    if (signal.action === 'HOLD') return;
    if (signal.confidence < this.minConfidence) return;

    // Cooldown check
    const lastSignal = this.lastSignals.get(candle.symbol);
    if (lastSignal) {
      const timeDiff = Date.now() - lastSignal.timestamp;
      const cooldownMs = this.signalCooldown * 60 * 1000;
      if (timeDiff < cooldownMs && lastSignal.action === signal.action) {
        if (process.env.DEBUG_MODE === 'true') {
          console.log(`   🔇 Cooldown active (${Math.round((cooldownMs - timeDiff) / 60000)}min remaining)`);
        }
        return;
      }
    }

    // ── SIGNAL PASSED ALL FILTERS ──
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`🎯 SIGNAL: ${signal.action} ${candle.symbol} @ ${candle.close}`);
    console.log(`   Confidence: ${signal.confidence}% | Confluence: ${signal.confluenceCount}`);
    console.log(`   SL: ${this.telegram.formatPrice(signal.stopLoss)} | TP: ${this.telegram.formatPrice(signal.takeProfit)}`);
    console.log(`   Reasons: ${signal.reasons.join(', ')}`);
    console.log(`${'═'.repeat(60)}\n`);

    // Send notification
    await this.telegram.sendSignal(signal);

    // Execute on MT5 if enabled
    if (process.env.MT5_ENABLED === 'true') {
      await this.mt5.executeSignal(signal);
    }

    // Update tracking
    this.lastSignals.set(candle.symbol, {
      action: signal.action,
      timestamp: Date.now()
    });

    this.stats.signalsToday.push({
      symbol: signal.symbol,
      action: signal.action,
      confidence: signal.confidence,
      time: new Date().toISOString()
    });
  }

  // ── DAILY REPORT ──
  scheduleDailyReport() {
    const now = new Date();
    const reportTime = new Date(now);
    reportTime.setUTCHours(23, 55, 0, 0); // 23:55 UTC
    
    if (reportTime <= now) {
      reportTime.setUTCDate(reportTime.getUTCDate() + 1);
    }

    const msUntilReport = reportTime.getTime() - now.getTime();
    
    setTimeout(async () => {
      await this.sendDailyReport();
      this.stats.signalsToday = []; // Reset
      this.scheduleDailyReport();
    }, msUntilReport);
    
    console.log(`📅 Daily report scheduled in ${(msUntilReport / 3600000).toFixed(1)} hours`);
  }

  async sendDailyReport() {
    const signals = this.stats.signalsToday;
    const health = this.marketData.getHealthStatus();

    const report = {
      totalSignals: signals.length,
      buySignals: signals.filter(s => s.action === 'BUY').length,
      sellSignals: signals.filter(s => s.action === 'SELL').length,
      avgConfidence: signals.length > 0
        ? Math.round(signals.reduce((sum, s) => sum + s.confidence, 0) / signals.length)
        : 0,
      apiCreditsUsed: health.apiCreditsUsedToday,
      apiDailyLimit: 800,
      uptime: formatUptime(process.uptime())
    };

    console.log('\n📊 Sending daily report...');
    await this.telegram.sendDailyReport(report);
  }

  getHealthStatus() {
    const dataHealth = this.marketData.getHealthStatus();
    return {
      signals: {
        todayCount: this.stats.signalsToday.length,
        totalAnalyses: this.stats.totalAnalyses,
        lastSignals: Object.fromEntries(this.lastSignals)
      },
      marketData: dataHealth,
      config: {
        minConfidence: this.minConfidence,
        minConfluence: this.minConfluence,
        cooldownMins: this.signalCooldown,
        timeframe: this.timeframe,
        watchlist: this.watchlist
      }
    };
  }
}

// ── START ──
const agent = new TradingAgent();
agentInstance = agent;

agent.start().catch(async (err) => {
  console.error('Fatal error:', err);
  try {
    await agent.telegram.sendError(`🚨 FATAL ERROR: ${err.message}`);
  } catch (e) {}
  process.exit(1);
});

// ── GRACEFUL SHUTDOWN ──
const shutdown = async (signal) => {
  console.log(`\n👋 Received ${signal}, shutting down...`);
  agent.marketData.stop();
  try {
    await agent.telegram.sendMessage('👋 *Trading Agent shutting down...*');
  } catch (e) {}
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ── UNCAUGHT ERROR HANDLING ──
process.on('uncaughtException', async (err) => {
  console.error('🚨 Uncaught Exception:', err);
  try {
    await agent.telegram.sendError(`🚨 Uncaught: ${err.message}`);
  } catch (e) {}
});

process.on('unhandledRejection', async (reason) => {
  console.error('🚨 Unhandled Rejection:', reason);
  try {
    await agent.telegram.sendError(`🚨 Unhandled: ${reason}`);
  } catch (e) {}
});