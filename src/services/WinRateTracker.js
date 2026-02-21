import fs from 'fs';
import path from 'path';

// ═══════════════════════════════════════════════════════════════════
// WIN RATE TRACKER
//
// What it does:
// 1. Logs every signal with entry, SL, TP, timestamp
// 2. After each candle update, checks open signals for SL/TP hits
// 3. Marks signals as WIN, LOSS, or OPEN
// 4. Saves to JSON file (persists across restarts)
// 5. Provides stats: win rate, avg R:R, best/worst symbols, etc.
// 6. Sends Discord notification when a signal resolves
//
// Usage in index.js:
//   import { WinRateTracker } from './services/WinRateTracker.js';
//   this.tracker = new WinRateTracker(this.telegram);
//   this.tracker.logSignal(signal);  // after sending signal
//   this.tracker.updatePrice(symbol, currentPrice);  // on each candle
// ═══════════════════════════════════════════════════════════════════

export class WinRateTracker {
  constructor(notifier = null) {
    this.notifier = notifier; // TelegramService instance for Discord alerts
    this.dataFile = path.resolve('./data/signals.json');
    this.signals = [];
    this.ensureDataDir();
    this.load();
  }

  ensureDataDir() {
    const dir = path.resolve('./data');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log('📁 Created ./data directory for win rate tracking');
    }
  }

  // ── LOAD FROM DISK ──
  load() {
    try {
      if (fs.existsSync(this.dataFile)) {
        const raw = fs.readFileSync(this.dataFile, 'utf8');
        this.signals = JSON.parse(raw);
        const open = this.signals.filter(s => s.status === 'OPEN').length;
        const closed = this.signals.filter(s => s.status !== 'OPEN').length;
        console.log(`📊 WinRateTracker: Loaded ${this.signals.length} signals (${open} open, ${closed} closed)`);
      }
    } catch (err) {
      console.error('WinRateTracker load error:', err.message);
      this.signals = [];
    }
  }

  // ── SAVE TO DISK ──
  save() {
    try {
      fs.writeFileSync(this.dataFile, JSON.stringify(this.signals, null, 2));
    } catch (err) {
      console.error('WinRateTracker save error:', err.message);
    }
  }

  // ── LOG A NEW SIGNAL ──
  logSignal(signal) {
    const entry = {
      id: `${signal.symbol}_${Date.now()}`,
      symbol: signal.symbol,
      action: signal.action,
      entryPrice: signal.price,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      riskReward: signal.riskReward,
      confidence: signal.confidence,
      confluenceCount: signal.confluenceCount,
      reasons: signal.reasons,
      context: signal.context,
      momentum: signal.momentum,
      indicators: signal.indicators,
      timestamp: Date.now(),
      timestampStr: new Date().toISOString(),
      status: 'OPEN',   // OPEN, WIN, LOSS, EXPIRED
      closePrice: null,
      closeTime: null,
      pnlR: null,       // P&L in R multiples (1.0 = hit TP exactly)
      durationMins: null
    };

    this.signals.push(entry);
    this.save();

    const risk = Math.abs(signal.price - signal.stopLoss).toFixed(5);
    console.log(`📝 Signal logged: ${signal.action} ${signal.symbol} @ ${signal.price} | SL:${signal.stopLoss} TP:${signal.takeProfit} | Risk: ${risk}`);

    return entry.id;
  }

  // ── CHECK OPEN SIGNALS AGAINST CURRENT PRICE ──
  // Call this on every candle update
  updatePrice(symbol, currentPrice, high, low) {
    const openSignals = this.signals.filter(
      s => s.symbol === symbol && s.status === 'OPEN'
    );

    if (openSignals.length === 0) return;

    let updated = false;

    for (const signal of openSignals) {
      const result = this._checkSignalResult(signal, currentPrice, high, low);

      if (result) {
        signal.status = result.status;
        signal.closePrice = result.closePrice;
        signal.closeTime = Date.now();
        signal.durationMins = Math.round((signal.closeTime - signal.timestamp) / 60000);
        signal.pnlR = result.pnlR;
        updated = true;

        console.log(`\n🏁 Signal resolved: ${signal.action} ${signal.symbol}`);
        console.log(`   Status: ${result.status} | Close: ${result.closePrice} | Duration: ${signal.durationMins}min | P&L: ${result.pnlR > 0 ? '+' : ''}${result.pnlR}R`);

        // Send Discord notification
        this._notifyResolved(signal);
      }

      // Auto-expire signals older than 4 hours (matches 5min scalping timeframe)
      const ageHours = (Date.now() - signal.timestamp) / 3600000;
      if (ageHours > 4 && signal.status === 'OPEN') {
        signal.status = 'EXPIRED';
        signal.closePrice = currentPrice;
        signal.closeTime = Date.now();
        signal.durationMins = Math.round((signal.closeTime - signal.timestamp) / 60000);
        const risk = Math.abs(signal.entryPrice - signal.stopLoss);
        signal.pnlR = parseFloat(((currentPrice - signal.entryPrice) / risk * (signal.action === 'BUY' ? 1 : -1)).toFixed(2));
        updated = true;
        console.log(`⏰ Signal expired: ${signal.action} ${signal.symbol} (24h timeout)`);
      }
    }

    if (updated) this.save();
  }

  // Check if SL or TP was hit using candle high/low
  _checkSignalResult(signal, currentPrice, high, low) {
    const candleHigh = high || currentPrice;
    const candleLow = low || currentPrice;
    const risk = Math.abs(signal.entryPrice - signal.stopLoss);

    if (signal.action === 'BUY') {
      // TP hit
      if (candleHigh >= signal.takeProfit) {
        return {
          status: 'WIN',
          closePrice: signal.takeProfit,
          pnlR: parseFloat((Math.abs(signal.takeProfit - signal.entryPrice) / risk).toFixed(2))
        };
      }
      // SL hit
      if (candleLow <= signal.stopLoss) {
        return {
          status: 'LOSS',
          closePrice: signal.stopLoss,
          pnlR: parseFloat((-Math.abs(signal.stopLoss - signal.entryPrice) / risk).toFixed(2))
        };
      }
    } else { // SELL
      // TP hit
      if (candleLow <= signal.takeProfit) {
        return {
          status: 'WIN',
          closePrice: signal.takeProfit,
          pnlR: parseFloat((Math.abs(signal.entryPrice - signal.takeProfit) / risk).toFixed(2))
        };
      }
      // SL hit
      if (candleHigh >= signal.stopLoss) {
        return {
          status: 'LOSS',
          closePrice: signal.stopLoss,
          pnlR: parseFloat((-Math.abs(signal.stopLoss - signal.entryPrice) / risk).toFixed(2))
        };
      }
    }

    return null; // Still open
  }

  // ── SEND DISCORD NOTIFICATION WHEN SIGNAL RESOLVES ──
  async _notifyResolved(signal) {
    if (!this.notifier) return;

    const isWin = signal.status === 'WIN';
    const emoji = isWin ? '✅' : signal.status === 'LOSS' ? '❌' : '⏰';
    const color = isWin ? 0x00ff00 : signal.status === 'LOSS' ? 0xff0000 : 0x888888;
    const stats = this.getStats(signal.symbol);

    try {
      await this.notifier.sendWithRetry(async () => {
        const axios = (await import('axios')).default;
        await axios.post(process.env.DISCORD_WEBHOOK_URL, {
          embeds: [{
            title: `${emoji} SIGNAL ${signal.status} — ${signal.symbol}`,
            color,
            fields: [
              { name: '📊 Symbol', value: signal.symbol, inline: true },
              { name: '📈 Action', value: signal.action, inline: true },
              { name: '⏱ Duration', value: `${signal.durationMins}min`, inline: true },
              { name: '💰 Entry', value: `${signal.entryPrice}`, inline: true },
              { name: '🏁 Close', value: `${signal.closePrice}`, inline: true },
              { name: '📊 P&L', value: `${signal.pnlR > 0 ? '+' : ''}${signal.pnlR}R`, inline: true },
              { name: '📈 Win Rate', value: `${stats.winRate}% (${stats.wins}W/${stats.losses}L)`, inline: true },
              { name: '💰 Total P&L', value: `${stats.totalR > 0 ? '+' : ''}${stats.totalR}R`, inline: true },
              { name: '📊 Avg Win', value: `${stats.avgWin}R`, inline: true }
            ],
            footer: { text: `Signal ID: ${signal.id}` },
            timestamp: new Date().toISOString()
          }]
        });
      });
    } catch (err) {
      console.error('WinRateTracker notify error:', err.message);
    }
  }

  // ── GET STATS ──
  getStats(symbol = null) {
    let signals = this.signals.filter(s => s.status !== 'OPEN' && s.status !== 'EXPIRED');
    if (symbol) signals = signals.filter(s => s.symbol === symbol);

    const wins = signals.filter(s => s.status === 'WIN');
    const losses = signals.filter(s => s.status === 'LOSS');
    const totalR = signals.reduce((sum, s) => sum + (s.pnlR || 0), 0);
    const winRate = signals.length > 0 ? ((wins.length / signals.length) * 100).toFixed(1) : 0;
    const avgWin = wins.length > 0 ? (wins.reduce((s, w) => s + w.pnlR, 0) / wins.length).toFixed(2) : 0;
    const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, l) => s + l.pnlR, 0) / losses.length).toFixed(2) : 0;
    const profitFactor = avgLoss > 0 ? ((avgWin * wins.length) / (avgLoss * losses.length)).toFixed(2) : '∞';
    const avgDuration = signals.length > 0 ? Math.round(signals.reduce((s, sig) => s + (sig.durationMins || 0), 0) / signals.length) : 0;

    return {
      total: signals.length,
      wins: wins.length,
      losses: losses.length,
      winRate: parseFloat(winRate),
      totalR: parseFloat(totalR.toFixed(2)),
      avgWin: parseFloat(avgWin),
      avgLoss: parseFloat(avgLoss),
      profitFactor,
      avgDurationMins: avgDuration,
      open: this.signals.filter(s => s.status === 'OPEN').length
    };
  }

  // ── GET FULL REPORT ──
  getFullReport() {
    const overall = this.getStats();
    const bySymbol = {};

    const symbols = [...new Set(this.signals.map(s => s.symbol))];
    for (const sym of symbols) {
      bySymbol[sym] = this.getStats(sym);
    }

    // Best/worst confidence bands
    const closed = this.signals.filter(s => s.status !== 'OPEN' && s.status !== 'EXPIRED');
    const highConf = closed.filter(s => s.confidence >= 70);
    const midConf = closed.filter(s => s.confidence >= 55 && s.confidence < 70);
    const lowConf = closed.filter(s => s.confidence < 55);

    const confBands = {
      high: this._bandStats(highConf),
      mid: this._bandStats(midConf),
      low: this._bandStats(lowConf)
    };

    return { overall, bySymbol, confBands };
  }

  _bandStats(signals) {
    if (signals.length === 0) return { total: 0, winRate: 0, totalR: 0 };
    const wins = signals.filter(s => s.status === 'WIN').length;
    return {
      total: signals.length,
      winRate: parseFloat(((wins / signals.length) * 100).toFixed(1)),
      totalR: parseFloat(signals.reduce((s, sig) => s + (sig.pnlR || 0), 0).toFixed(2))
    };
  }

  // ── PRINT REPORT TO CONSOLE ──
  printReport() {
    const report = this.getFullReport();
    const o = report.overall;

    console.log('\n' + '═'.repeat(60));
    console.log('📊 WIN RATE TRACKER REPORT');
    console.log('═'.repeat(60));
    console.log(`Total Closed: ${o.total} | Wins: ${o.wins} | Losses: ${o.losses}`);
    console.log(`Win Rate: ${o.winRate}% | Total P&L: ${o.totalR > 0 ? '+' : ''}${o.totalR}R`);
    console.log(`Avg Win: +${o.avgWin}R | Avg Loss: -${o.avgLoss}R | Profit Factor: ${o.profitFactor}`);
    console.log(`Avg Duration: ${o.avgDurationMins}min | Open: ${o.open}`);

    console.log('\n📊 By Symbol:');
    for (const [sym, stats] of Object.entries(report.bySymbol)) {
      console.log(`  ${sym}: ${stats.winRate}% WR (${stats.wins}W/${stats.losses}L) | ${stats.totalR > 0 ? '+' : ''}${stats.totalR}R`);
    }

    console.log('\n📊 By Confidence:');
    console.log(`  High (70%+): ${report.confBands.high.winRate}% WR (${report.confBands.high.total} signals) | ${report.confBands.high.totalR}R`);
    console.log(`  Mid (55-69%): ${report.confBands.mid.winRate}% WR (${report.confBands.mid.total} signals) | ${report.confBands.mid.totalR}R`);
    console.log(`  Low (<55%): ${report.confBands.low.winRate}% WR (${report.confBands.low.total} signals) | ${report.confBands.low.totalR}R`);
    console.log('═'.repeat(60) + '\n');
  }
}