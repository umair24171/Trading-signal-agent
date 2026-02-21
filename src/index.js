import dotenv from 'dotenv';
dotenv.config();

import http from 'http';
import { MarketDataService } from './services/MarketDataService.js';
import { SignalEngine } from './engine/SignalEngine.js';
import { TelegramService } from './services/TelegramService.js';
import { MT5Bridge } from './services/MT5Bridge.js';
import { WinRateTracker } from './services/WinRateTracker.js';

// ── HEALTH SERVER ──
const PORT = process.env.PORT || 3000;
let agentInstance = null;

http.createServer((req, res) => {
  const health = agentInstance?.getHealthStatus() || {};
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'running', agent: 'Trading Signal Agent v2', uptime: process.uptime(), uptimeFormatted: formatUptime(process.uptime()), ...health }, null, 2));
}).listen(PORT, () => {
  console.log(`🌐 Health server running on port ${PORT}`);
});

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

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
║  NEW: SR Detector v2, Win Rate Tracker, Backtest Engine      ║
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
    this.tracker = new WinRateTracker(this.telegram); // ← WIN RATE TRACKER

    this.lastSignals = new Map();
    this.signalCooldown = parseInt(process.env.SIGNAL_COOLDOWN_MINS) || 15;

    this.stats = { signalsToday: [], totalAnalyses: 0, startTime: Date.now() };
  }

  async start() {
    console.log('🚀 Agent starting...\n');

    // Print current tracker stats on startup
    this.tracker.printReport();

    await this.telegram.sendMessage(`
🤖 *Trading Agent v2 Started*

📊 Watching: ${this.watchlist.join(', ')}
⏱ Timeframe: ${this.timeframe}
🎯 Min Confidence: ${this.minConfidence}%
🔗 Min Confluence: ${this.minConfluence} signals

*New v2 Features:*
• SR Detector v2 (clustered swing levels with strength scores)
• Win Rate Tracker (auto SL/TP hit detection)
• Backtest engine available (run: node src/backtest.js)

📊 Tracker: ${this.tracker.getStats().total} closed signals | ${this.tracker.getStats().winRate}% win rate
    `);

    await this.marketData.fetchHistoricalData();

    for (const symbol of this.watchlist) {
      const historicalCandles = this.marketData.getCandles(symbol);
      if (historicalCandles.length > 0) {
        this.signalEngine.loadHistoricalCandles(symbol, historicalCandles);
      }
    }
    console.log('📊 Indicators warmed up with historical data\n');

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

    await this.marketData.startPolling();
    console.log('✅ Agent running - waiting for high-confluence signals...\n');

    this.scheduleDailyReport();
  }

  async processCandle(candle) {
    this.signalEngine.addCandle(candle);
    const signal = this.signalEngine.analyze(candle.symbol);
    this.stats.totalAnalyses++;

    // ── UPDATE WIN RATE TRACKER on every candle ──
    this.tracker.updatePrice(candle.symbol, candle.close, candle.high, candle.low);

    if (!signal) return;

    if (process.env.DEBUG_MODE === 'true') {
      const ctx = signal.context || {};
      const mom = signal.momentum || {};
      console.log(`\n📊 [${candle.symbol}] Analysis #${this.stats.totalAnalyses}:`);
      console.log(`   Price: ${candle.close} | Action: ${signal.action} | Confidence: ${signal.confidence}%`);
      console.log(`   Events: ${signal.eventCount || 0} | States: ${signal.stateCount || 0} | Total: ${signal.confluenceCount} (need ${this.minConfluence})`);
      console.log(`   Context: ${ctx.trend} trend (ADX:${ctx.trendStrength?.toFixed(0) || '?'}) | ${ctx.regime} | ${ctx.session} | Vol: ${ctx.volatility}`);
      console.log(`   RSI: ${signal.indicators.rsi} | Stoch: ${signal.indicators.stochK}/${signal.indicators.stochD} | MACD: ${signal.indicators.macd}`);
      console.log(`   Momentum: ${mom.bullishCandles || 0}🟢/${mom.bearishCandles || 0}🔴 candles | Structure: ${mom.priceStructure || 'N/A'}`);
      if (signal.action !== 'HOLD') {
        console.log(`   S/R Supports: ${ctx.supportLevels || 'N/A'}`);
        console.log(`   S/R Resistances: ${ctx.resistanceLevels || 'N/A'}`);
      }
      if (signal.reasons.length > 0) console.log(`   ✅ Reasons: ${signal.reasons.slice(0, 6).join(' | ')}`);
      if (signal.warnings?.length > 0) console.log(`   ⚠️ ${signal.warnings.join(' | ')}`);
      if (signal.action === 'HOLD') console.log(`   ⏸️  HOLD`);
      else if (signal.confidence < this.minConfidence) console.log(`   ❌ Rejected: confidence ${signal.confidence}% < ${this.minConfidence}%`);
      else console.log(`   🎯 SIGNAL QUALIFIES! → ${signal.action} @ ${signal.confidence}%`);
    }

    if (signal.action === 'HOLD') return;
    if (signal.confidence < this.minConfidence) return;

    const lastSignal = this.lastSignals.get(candle.symbol);
    if (lastSignal) {
      const timeDiff = Date.now() - lastSignal.timestamp;
      const cooldownMs = this.signalCooldown * 60 * 1000;
      if (timeDiff < cooldownMs && lastSignal.action === signal.action) {
        if (process.env.DEBUG_MODE === 'true')
          console.log(`   🔇 Cooldown active (${Math.round((cooldownMs - timeDiff) / 60000)}min remaining)`);
        return;
      }
    }

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`🎯 SIGNAL: ${signal.action} ${candle.symbol} @ ${candle.close}`);
    console.log(`   Confidence: ${signal.confidence}% | Confluence: ${signal.confluenceCount}`);
    console.log(`   SL: ${signal.stopLoss?.toFixed(2)} | TP: ${signal.takeProfit?.toFixed(2)}`);
    console.log(`   Reasons: ${signal.reasons.join(', ')}`);
    console.log(`${'═'.repeat(60)}\n`);

    // Send notification
    await this.telegram.sendSignal(signal);

    // ── LOG TO WIN RATE TRACKER ──
    this.tracker.logSignal(signal);

    if (process.env.MT5_ENABLED === 'true') await this.mt5.executeSignal(signal);

    this.lastSignals.set(candle.symbol, { action: signal.action, timestamp: Date.now() });

    this.stats.signalsToday.push({
      symbol: signal.symbol, action: signal.action,
      confidence: signal.confidence, time: new Date().toISOString()
    });
  }

  scheduleDailyReport() {
    const now = new Date();
    const reportTime = new Date(now);
    reportTime.setUTCHours(23, 55, 0, 0);
    if (reportTime <= now) reportTime.setUTCDate(reportTime.getUTCDate() + 1);

    setTimeout(async () => {
      await this.sendDailyReport();
      this.stats.signalsToday = [];
      this.scheduleDailyReport();
    }, reportTime.getTime() - now.getTime());

    console.log(`📅 Daily report scheduled in ${((reportTime.getTime() - now.getTime()) / 3600000).toFixed(1)} hours`);
  }

  async sendDailyReport() {
    const signals = this.stats.signalsToday;
    const health = this.marketData.getHealthStatus();
    const trackerStats = this.tracker.getStats();

    const report = {
      totalSignals: signals.length,
      buySignals: signals.filter(s => s.action === 'BUY').length,
      sellSignals: signals.filter(s => s.action === 'SELL').length,
      avgConfidence: signals.length > 0
        ? Math.round(signals.reduce((sum, s) => sum + s.confidence, 0) / signals.length) : 0,
      apiCreditsUsed: health.apiCreditsUsedToday,
      apiDailyLimit: 800,
      uptime: formatUptime(process.uptime()),
      // Tracker stats
      winRate: trackerStats.winRate,
      totalR: trackerStats.totalR,
      profitFactor: trackerStats.profitFactor
    };

    console.log('\n📊 Sending daily report...');
    await this.telegram.sendDailyReport(report);
    this.tracker.printReport();
  }

  getHealthStatus() {
    const dataHealth = this.marketData.getHealthStatus();
    const trackerStats = this.tracker.getStats();
    return {
      signals: { todayCount: this.stats.signalsToday.length, totalAnalyses: this.stats.totalAnalyses },
      tracker: trackerStats,
      marketData: dataHealth,
      config: {
        minConfidence: this.minConfidence, minConfluence: this.minConfluence,
        cooldownMins: this.signalCooldown, timeframe: this.timeframe, watchlist: this.watchlist
      }
    };
  }
}

const agent = new TradingAgent();
agentInstance = agent;

agent.start().catch(async (err) => {
  console.error('Fatal error:', err);
  try { await agent.telegram.sendError(`🚨 FATAL ERROR: ${err.message}`); } catch (e) {}
  process.exit(1);
});

const shutdown = async (signal) => {
  console.log(`\n👋 Received ${signal}, shutting down...`);
  // Print final tracker report before shutdown
  agent.tracker.printReport();
  agent.marketData.stop();
  try { await agent.telegram.sendMessage('👋 *Trading Agent shutting down...*'); } catch (e) {}
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', async (err) => {
  console.error('🚨 Uncaught Exception:', err);
  try { await agent.telegram.sendError(`🚨 Uncaught: ${err.message}`); } catch (e) {}
});

process.on('unhandledRejection', async (reason) => {
  console.error('🚨 Unhandled Rejection:', reason);
  try { await agent.telegram.sendError(`🚨 Unhandled: ${reason}`); } catch (e) {}
});