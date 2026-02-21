// ═══════════════════════════════════════════════════════════════════
// BACKTEST.JS — Historical Signal Engine Testing
//
// Usage:
//   node src/backtest.js
//   node src/backtest.js --symbol XAU/USD --days 30
//   node src/backtest.js --symbol BTC/USD --days 60 --confidence 55
//
// What it does:
// 1. Downloads historical 5min candles from TwelveData (one-time)
// 2. Caches them to ./data/historical/ so you don't waste API credits
// 3. Replays candles through SignalEngine one by one
// 4. Simulates SL/TP hits on subsequent candles
// 5. Prints full stats: win rate, P&L in R, best/worst signals
//
// Run this BEFORE going live to validate any engine changes!
// ═══════════════════════════════════════════════════════════════════

import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { SignalEngine } from './engine/SignalEngine.js';

// ── CLI ARGS ──
const args = process.argv.slice(2);
const getArg = (name, def) => {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : def;
};

const SYMBOL = getArg('symbol', 'XAU/USD');
const DAYS = parseInt(getArg('days', '30'));
const MIN_CONFIDENCE = parseInt(getArg('confidence', '60'));
const MIN_CONFLUENCE = parseInt(getArg('confluence', '3'));
const TIMEFRAME = getArg('timeframe', '5min');
const OUTPUT_FILE = getArg('output', `./data/backtest_${SYMBOL.replace('/', '')}_${DAYS}d.json`);

// ── RATE LIMITER ──
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── FETCH HISTORICAL DATA ──
async function fetchHistorical(symbol, timeframe, outputSize) {
  const cacheFile = `./data/historical/${symbol.replace('/', '')}_${timeframe}_${outputSize}.json`;
  fs.mkdirSync('./data/historical', { recursive: true });

  // Use cache if fresh enough (< 6 hours old)
  if (fs.existsSync(cacheFile)) {
    const stat = fs.statSync(cacheFile);
    const ageHours = (Date.now() - stat.mtimeMs) / 3600000;
    if (ageHours < 6) {
      console.log(`📦 Using cached data (${ageHours.toFixed(1)}h old)`);
      return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    }
  }

  console.log(`📡 Fetching ${outputSize} candles for ${symbol} from TwelveData...`);

  const response = await axios.get('https://api.twelvedata.com/time_series', {
    params: {
      symbol,
      interval: timeframe,
      outputsize: outputSize,
      apikey: process.env.TWELVE_DATA_API_KEY
    },
    timeout: 30000
  });

  if (response.data.status === 'error') {
    throw new Error(`API Error: ${response.data.message}`);
  }

  if (!response.data.values) {
    throw new Error('No data returned from API');
  }

  const candles = response.data.values
    .reverse()
    .map(v => ({
      symbol,
      timestamp: new Date(v.datetime).getTime(),
      open: parseFloat(v.open),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close),
      volume: parseFloat(v.volume || 0)
    }));

  // Cache it
  fs.writeFileSync(cacheFile, JSON.stringify(candles, null, 2));
  console.log(`✅ Fetched and cached ${candles.length} candles`);
  return candles;
}

// ── SIMULATE SIGNAL OUTCOME ──
// Check future candles to see if SL or TP was hit
function simulateOutcome(signal, candles, signalIndex) {
  if (signal.action === 'HOLD') return null;

  const futureCandles = candles.slice(signalIndex + 1, signalIndex + 48); // Max 4 hours (48 × 5min)

  for (let i = 0; i < futureCandles.length; i++) {
    const candle = futureCandles[i];

    if (signal.action === 'BUY') {
      if (candle.high >= signal.takeProfit) {
        return { outcome: 'WIN', exitPrice: signal.takeProfit, candlesHeld: i + 1 };
      }
      if (candle.low <= signal.stopLoss) {
        return { outcome: 'LOSS', exitPrice: signal.stopLoss, candlesHeld: i + 1 };
      }
    } else { // SELL
      if (candle.low <= signal.takeProfit) {
        return { outcome: 'WIN', exitPrice: signal.takeProfit, candlesHeld: i + 1 };
      }
      if (candle.high >= signal.stopLoss) {
        return { outcome: 'LOSS', exitPrice: signal.stopLoss, candlesHeld: i + 1 };
      }
    }
  }

  // Neither hit in 200 candles
  const lastClose = futureCandles[futureCandles.length - 1]?.close || signal.price;
  const risk = Math.abs(signal.price - signal.stopLoss);
  const pnl = (signal.action === 'BUY' ? lastClose - signal.price : signal.price - lastClose) / risk;

  return {
    outcome: 'EXPIRED',
    exitPrice: lastClose,
    candlesHeld: futureCandles.length,
    pnlR: parseFloat(pnl.toFixed(2))
  };
}

// ── PRINT RESULTS ──
function printResults(results, allSignals) {
  console.log('\n' + '═'.repeat(70));
  console.log('📊 BACKTEST RESULTS');
  console.log('═'.repeat(70));
  console.log(`Symbol: ${SYMBOL} | Timeframe: ${TIMEFRAME} | Days: ${DAYS}`);
  console.log(`Min Confidence: ${MIN_CONFIDENCE}% | Min Confluence: ${MIN_CONFLUENCE}`);
  console.log(`Total candles: ${allSignals.totalCandles} | Signals generated: ${allSignals.totalSignals}`);
  console.log(`Qualified (>= ${MIN_CONFIDENCE}%): ${results.length}`);
  console.log('─'.repeat(70));

  const wins = results.filter(r => r.outcome === 'WIN');
  const losses = results.filter(r => r.outcome === 'LOSS');
  const expired = results.filter(r => r.outcome === 'EXPIRED');

  const totalR = results.reduce((s, r) => s + (r.pnlR || 0), 0);
  const winRate = results.length > 0 ? ((wins.length / results.length) * 100).toFixed(1) : 0;
  const avgWin = wins.length > 0 ? (wins.reduce((s, r) => s + r.pnlR, 0) / wins.length).toFixed(2) : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, r) => s + r.pnlR, 0) / losses.length).toFixed(2) : 0;
  const profitFactor = avgLoss > 0 ? ((avgWin * wins.length) / (avgLoss * losses.length)).toFixed(2) : '∞';
  const avgDuration = results.length > 0
    ? Math.round(results.reduce((s, r) => s + (r.candlesHeld * 5), 0) / results.length)
    : 0;

  console.log(`\n✅ WINS:    ${wins.length}`);
  console.log(`❌ LOSSES:  ${losses.length}`);
  console.log(`⏰ EXPIRED: ${expired.length}`);
  console.log(`\n📈 Win Rate:      ${winRate}%`);
  console.log(`💰 Total P&L:     ${totalR > 0 ? '+' : ''}${totalR.toFixed(2)}R`);
  console.log(`📊 Avg Win:       +${avgWin}R`);
  console.log(`📊 Avg Loss:      -${avgLoss}R`);
  console.log(`📊 Profit Factor: ${profitFactor}`);
  console.log(`⏱ Avg Duration:  ${avgDuration}min`);

  // By signal direction
  const buys = results.filter(r => r.action === 'BUY');
  const sells = results.filter(r => r.action === 'SELL');
  if (buys.length > 0 && sells.length > 0) {
    const buyWins = buys.filter(r => r.outcome === 'WIN').length;
    const sellWins = sells.filter(r => r.outcome === 'WIN').length;
    console.log(`\n📊 BUY signals:  ${buys.length} | Win Rate: ${((buyWins / buys.length) * 100).toFixed(0)}%`);
    console.log(`📊 SELL signals: ${sells.length} | Win Rate: ${((sellWins / sells.length) * 100).toFixed(0)}%`);
  }

  // By confidence band
  console.log('\n📊 Performance by Confidence:');
  const bands = [
    { label: '70%+', filter: r => r.confidence >= 70 },
    { label: '60-69%', filter: r => r.confidence >= 60 && r.confidence < 70 },
    { label: '50-59%', filter: r => r.confidence >= 50 && r.confidence < 60 },
  ];

  for (const band of bands) {
    const bSignals = results.filter(band.filter);
    if (bSignals.length === 0) continue;
    const bWins = bSignals.filter(r => r.outcome === 'WIN').length;
    const bR = bSignals.reduce((s, r) => s + (r.pnlR || 0), 0);
    console.log(`  ${band.label}: ${bSignals.length} signals | ${((bWins / bSignals.length) * 100).toFixed(0)}% WR | ${bR > 0 ? '+' : ''}${bR.toFixed(2)}R`);
  }

  // Last 10 signals
  console.log('\n📋 Last 10 Signals:');
  console.log('  Time                 | Action | Conf | R:R  | Outcome | P&L');
  console.log('  ---------------------|--------|------|------|---------|-----');
  results.slice(-10).forEach(r => {
    const time = new Date(r.timestamp).toISOString().slice(0, 16).replace('T', ' ');
    const outcome = r.outcome.padEnd(7);
    const pnl = r.pnlR >= 0 ? `+${r.pnlR}R` : `${r.pnlR}R`;
    console.log(`  ${time} | ${r.action.padEnd(6)} | ${r.confidence}% | ${r.riskReward}x | ${outcome} | ${pnl}`);
  });

  console.log('\n' + '═'.repeat(70));
}

// ── MAIN ──
async function runBacktest() {
  console.log(`\n🔬 BACKTEST ENGINE`);
  console.log(`Symbol: ${SYMBOL} | Days: ${DAYS} | Min Confidence: ${MIN_CONFIDENCE}%\n`);

  // TwelveData 5min candles: ~288 per day
  const outputSize = Math.min(DAYS * 290, 5000);

  let candles;
  try {
    candles = await fetchHistorical(SYMBOL, TIMEFRAME, outputSize);
  } catch (err) {
    console.error('❌ Failed to fetch data:', err.message);
    process.exit(1);
  }

  console.log(`\n📊 Replaying ${candles.length} candles through SignalEngine v6...\n`);

  const engine = new SignalEngine({ minConfluence: MIN_CONFLUENCE, backtestMode: true });
  const warmupCandles = 110; // EMA100 needs 100+ candles — this was the main bug

  let lastSignalTime = 0;
  const cooldownMs = 15 * 60 * 1000;

  // Track recent signals to prevent clustering (max 2 same direction per 3h)
  const recentSignals = [];
  const clusterWindow = 3 * 60 * 60 * 1000; // 3 hours
  const maxSameDirectionIn3h = 2;

  const results = [];
  const allSignals = { totalCandles: 0, totalSignals: 0 };
  let processed = 0;

  // Debug: track block reasons
  const blockReasons = {};
  let holdCount = 0;

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];

    // ── FIX: Pass candle timestamp so session uses historical time, not now ──
    engine.currentCandleTime = candle.timestamp;

    engine.addCandle(candle);
    allSignals.totalCandles++;

    if (i < warmupCandles) continue;

    const signal = engine.analyze(SYMBOL);
    if (!signal) continue;

    // Debug: collect block reasons
    if (signal.action === 'HOLD' && signal.warnings?.length > 0) {
      holdCount++;
      for (const w of signal.warnings) {
        const key = w.replace(/[\d.]+/g, 'N').substring(0, 60);
        blockReasons[key] = (blockReasons[key] || 0) + 1;
      }
    }

    if (signal.action !== 'HOLD') {
      allSignals.totalSignals++;

      // Debug: print EMA100 availability on first few signals
      if (allSignals.totalSignals <= 3) {
        console.log(`   🔍 Signal #${allSignals.totalSignals}: ${signal.action} @ ${signal.price} | EMA100 in reasons/warnings: ${JSON.stringify(signal.warnings).includes('EMA100') || JSON.stringify(signal.reasons).includes('EMA100') ? 'YES' : 'NOT TRIGGERED'}`);
      }

      // Confidence filter
      if (signal.confidence >= MIN_CONFIDENCE) {
        // Cooldown check
        const timeDiff = candle.timestamp - lastSignalTime;
        if (timeDiff < cooldownMs) continue;

        // Cluster check — max 2 same-direction signals in 3h window
        // Use candle.timestamp (historical time) not Date.now()
        const windowStart = candle.timestamp - clusterWindow;
        const recentSameDir = recentSignals.filter(s =>
          s.action === signal.action && s.timestamp >= windowStart
        );
        if (recentSameDir.length >= maxSameDirectionIn3h) continue;

        // Simulate outcome
        const outcome = simulateOutcome(signal, candles, i);
        if (outcome) {
          const risk = Math.abs(signal.price - signal.stopLoss);
          const pnlR = outcome.outcome === 'WIN'
            ? parseFloat((Math.abs(outcome.exitPrice - signal.price) / risk).toFixed(2))
            : outcome.outcome === 'LOSS'
            ? parseFloat((-Math.abs(outcome.exitPrice - signal.price) / risk).toFixed(2))
            : (outcome.pnlR || 0);

          results.push({
            timestamp: candle.timestamp,
            symbol: SYMBOL,
            action: signal.action,
            entryPrice: signal.price,
            stopLoss: signal.stopLoss,
            takeProfit: signal.takeProfit,
            riskReward: signal.riskReward,
            confidence: signal.confidence,
            confluenceCount: signal.confluenceCount,
            reasons: signal.reasons,
            context: signal.context,
            outcome: outcome.outcome,
            exitPrice: outcome.exitPrice,
            candlesHeld: outcome.candlesHeld,
            pnlR
          });

          recentSignals.push({ action: signal.action, timestamp: candle.timestamp });
          lastSignalTime = candle.timestamp;
        }
      }
    }

    // Progress indicator
    processed++;
    if (processed % 500 === 0) {
      const pct = ((i / candles.length) * 100).toFixed(0);
      process.stdout.write(`\r   Progress: ${pct}% | Signals: ${results.length}`);
    }
  }

  process.stdout.write('\n');

  // ── DEBUG: Show why signals were blocked ──
  console.log(`\n🔍 WHY SIGNALS WERE BLOCKED (${holdCount} HOLD results with warnings):`);
  const sorted = Object.entries(blockReasons).sort((a, b) => b[1] - a[1]).slice(0, 15);
  sorted.forEach(([reason, count]) => {
    console.log(`  ${count}x — ${reason}`);
  });

  // Save results
  fs.mkdirSync('./data', { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify({ config: { SYMBOL, DAYS, MIN_CONFIDENCE, TIMEFRAME }, allSignals, results }, null, 2));
  console.log(`\n💾 Results saved to: ${OUTPUT_FILE}`);

  // Print report
  printResults(results, allSignals);
}

runBacktest().catch(err => {
  console.error('Backtest failed:', err);
  process.exit(1);
});