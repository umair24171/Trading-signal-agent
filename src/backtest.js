// ═══════════════════════════════════════════════════════════════════
// BACKTEST.JS v3 — With MTF 15min + 1h Macro Trend Filter
//
// Usage:
//   node src/backtest.js --symbol XAU/USD --days 90
//   node src/backtest.js --symbol XAU/USD --days 90 --confidence 55
//   node src/backtest.js --symbol EUR/USD --days 60
//
// What's new in v3:
//   - Fetches 1h candles for macro trend filter
//   - Feeds 1h candles into SignalEngine macroCandles store
//   - Macro filter blocks counter-trend signals (data-proven fix)
//   - Block reasons show macro blocks with 🏔️ marker
// ═══════════════════════════════════════════════════════════════════

import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs';
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

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── FETCH HISTORICAL DATA (with caching) ──
async function fetchHistorical(symbol, timeframe, outputSize) {
  const cacheFile = `./data/historical/${symbol.replace('/', '')}_${timeframe}_${outputSize}.json`;
  fs.mkdirSync('./data/historical', { recursive: true });

  if (fs.existsSync(cacheFile)) {
    const stat = fs.statSync(cacheFile);
    const ageHours = (Date.now() - stat.mtimeMs) / 3600000;
    if (ageHours < 6) {
      console.log(`📦 Using cached ${timeframe} data (${ageHours.toFixed(1)}h old)`);
      return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    }
  }

  console.log(`📡 Fetching ${outputSize} × ${timeframe} candles for ${symbol} from TwelveData...`);

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

  fs.writeFileSync(cacheFile, JSON.stringify(candles, null, 2));
  console.log(`✅ Fetched and cached ${candles.length} × ${timeframe} candles`);
  return candles;
}

// ── SIMULATE SIGNAL OUTCOME ──
function simulateOutcome(signal, candles, signalIndex) {
  if (signal.action === 'HOLD') return null;

  const futureCandles = candles.slice(signalIndex + 1, signalIndex + 48);

  for (let i = 0; i < futureCandles.length; i++) {
    const candle = futureCandles[i];

    if (signal.action === 'BUY') {
      if (candle.high >= signal.takeProfit) return { outcome: 'WIN', exitPrice: signal.takeProfit, candlesHeld: i + 1 };
      if (candle.low <= signal.stopLoss) return { outcome: 'LOSS', exitPrice: signal.stopLoss, candlesHeld: i + 1 };
    } else {
      if (candle.low <= signal.takeProfit) return { outcome: 'WIN', exitPrice: signal.takeProfit, candlesHeld: i + 1 };
      if (candle.high >= signal.stopLoss) return { outcome: 'LOSS', exitPrice: signal.stopLoss, candlesHeld: i + 1 };
    }
  }

  const lastClose = futureCandles[futureCandles.length - 1]?.close || signal.price;
  const risk = Math.abs(signal.price - signal.stopLoss);
  const pnl = (signal.action === 'BUY' ? lastClose - signal.price : signal.price - lastClose) / risk;

  return { outcome: 'EXPIRED', exitPrice: lastClose, candlesHeld: futureCandles.length, pnlR: parseFloat(pnl.toFixed(2)) };
}

// ── PRINT RESULTS ──
function printResults(results, allSignals, label = '') {
  console.log('\n' + '═'.repeat(70));
  console.log(`📊 BACKTEST RESULTS ${label}`);
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

  const buys = results.filter(r => r.action === 'BUY');
  const sells = results.filter(r => r.action === 'SELL');
  if (buys.length > 0) {
    const buyWins = buys.filter(r => r.outcome === 'WIN').length;
    console.log(`\n📊 BUY signals:  ${buys.length} | Win Rate: ${((buyWins / buys.length) * 100).toFixed(0)}%`);
  }
  if (sells.length > 0) {
    const sellWins = sells.filter(r => r.outcome === 'WIN').length;
    console.log(`📊 SELL signals: ${sells.length} | Win Rate: ${((sellWins / sells.length) * 100).toFixed(0)}%`);
  }

  console.log('\n📊 Performance by Confidence:');
  const bands = [
    { label: '80%+',   filter: r => r.confidence >= 80 },
    { label: '70-79%', filter: r => r.confidence >= 70 && r.confidence < 80 },
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

  // Macro breakdown
  const macroBoosted = results.filter(r => r.macroAction === 'BOOSTED');
  const macroPenalized = results.filter(r => r.macroAction === 'PENALIZED');
  const macroNeutral = results.filter(r => r.macroAction === 'NEUTRAL');
  console.log('\n📊 1h Macro Filter Impact:');
  if (macroBoosted.length) {
    const bw = macroBoosted.filter(r => r.outcome === 'WIN').length;
    console.log(`  ✅ Macro Aligned (boosted):   ${macroBoosted.length} signals | ${((bw / macroBoosted.length) * 100).toFixed(0)}% WR`);
  }
  if (macroNeutral.length) {
    const nw = macroNeutral.filter(r => r.outcome === 'WIN').length;
    console.log(`  ➡️  Macro Neutral:             ${macroNeutral.length} signals | ${((nw / macroNeutral.length) * 100).toFixed(0)}% WR`);
  }
  if (macroPenalized.length) {
    const pw = macroPenalized.filter(r => r.outcome === 'WIN').length;
    console.log(`  ⚠️  Macro Counter (penalized): ${macroPenalized.length} signals | ${((pw / macroPenalized.length) * 100).toFixed(0)}% WR`);
  }

  // MTF breakdown
  const mtfBoosted = results.filter(r => r.mtfAction === 'BOOSTED');
  const mtfPenalized = results.filter(r => r.mtfAction === 'PENALIZED');
  const mtfNeutral = results.filter(r => r.mtfAction === 'NEUTRAL');
  if (mtfBoosted.length || mtfPenalized.length) {
    console.log('\n📊 15min MTF Filter Impact:');
    if (mtfBoosted.length) {
      const bw = mtfBoosted.filter(r => r.outcome === 'WIN').length;
      console.log(`  ✅ MTF Aligned (boosted):   ${mtfBoosted.length} signals | ${((bw / mtfBoosted.length) * 100).toFixed(0)}% WR`);
    }
    if (mtfNeutral.length) {
      const nw = mtfNeutral.filter(r => r.outcome === 'WIN').length;
      console.log(`  ➡️  MTF Neutral:             ${mtfNeutral.length} signals | ${((nw / mtfNeutral.length) * 100).toFixed(0)}% WR`);
    }
    if (mtfPenalized.length) {
      const pw = mtfPenalized.filter(r => r.outcome === 'WIN').length;
      console.log(`  ⚠️  MTF Counter (penalized): ${mtfPenalized.length} signals | ${((pw / mtfPenalized.length) * 100).toFixed(0)}% WR`);
    }
  }

  console.log('\n📋 Last 10 Signals:');
  console.log('  Time                 | Action | Conf | Macro    | MTF      | Outcome | P&L');
  console.log('  ---------------------|--------|------|----------|----------|---------|-----');
  results.slice(-10).forEach(r => {
    const time = new Date(r.timestamp).toISOString().slice(0, 16).replace('T', ' ');
    const outcome = r.outcome.padEnd(7);
    const pnl = r.pnlR >= 0 ? `+${r.pnlR}R` : `${r.pnlR}R`;
    const macro = (r.macroTrend || 'N/A').padEnd(8);
    const mtf = (r.mtfTrend || 'N/A').padEnd(8);
    console.log(`  ${time} | ${r.action.padEnd(6)} | ${r.confidence}% | ${macro} | ${mtf} | ${outcome} | ${pnl}`);
  });

  console.log('\n' + '═'.repeat(70));
  return { winRate: parseFloat(winRate), totalR: parseFloat(totalR.toFixed(2)), wins: wins.length, losses: losses.length, total: results.length };
}

// ── MAIN ──
async function runBacktest() {
  console.log(`\n🔬 BACKTEST ENGINE v3 (MTF 15min + 1h Macro)`);
  console.log(`Symbol: ${SYMBOL} | Days: ${DAYS} | Min Confidence: ${MIN_CONFIDENCE}%\n`);

  // ── FETCH 5MIN CANDLES ──
  const outputSize5m = Math.min(DAYS * 290, 5000);
  let candles5m;
  try {
    candles5m = await fetchHistorical(SYMBOL, TIMEFRAME, outputSize5m);
  } catch (err) {
    console.error('❌ Failed to fetch 5min data:', err.message);
    process.exit(1);
  }

  // ── FETCH 15MIN CANDLES ──
  await sleep(2000);
  const outputSize15m = Math.min(DAYS * 97, 5000);
  let candles15m = [];
  try {
    candles15m = await fetchHistorical(SYMBOL, '15min', outputSize15m);
    console.log(`✅ 15min candles: ${candles15m.length} loaded for MTF`);
  } catch (err) {
    console.warn('⚠️ Failed to fetch 15min data — MTF filter will be NEUTRAL:', err.message);
  }

  // ── FETCH 1H CANDLES ──
  await sleep(2000);
  const outputSize1h = Math.min(DAYS * 25, 500);
  let candles1h = [];
  try {
    candles1h = await fetchHistorical(SYMBOL, '1h', outputSize1h);
    console.log(`✅ 1h candles: ${candles1h.length} loaded for Macro trend\n`);
  } catch (err) {
    console.warn('⚠️ Failed to fetch 1h data — Macro filter will be NEUTRAL:', err.message);
  }

  console.log(`📊 Replaying ${candles5m.length} × 5min candles through SignalEngine + Macro + MTF...\n`);

  const engine = new SignalEngine({ minConfluence: MIN_CONFLUENCE, backtestMode: true });
  const warmupCandles = 110;

  // ── PRE-LOAD INITIAL CANDLES UP TO WARMUP POINT ──
  const warmupTime = candles5m[warmupCandles]?.timestamp || 0;

  if (candles15m.length > 0) {
    const initial15m = candles15m.filter(c => c.timestamp <= warmupTime);
    if (initial15m.length > 0) engine.loadMTFCandles(SYMBOL, initial15m);
  }

  // 1h macro: load all candles up to warmup time (no lookahead)
  if (candles1h.length > 0) {
    const initial1h = candles1h.filter(c => c.timestamp <= warmupTime);
    if (initial1h.length > 0) engine.loadMacroCandles(SYMBOL, initial1h);
  }

  let lastSignalTime = 0;
  const cooldownMs = 15 * 60 * 1000;
  const recentSignals = [];
  const clusterWindow = 3 * 60 * 60 * 1000;
  const maxSameDirectionIn3h = 2;

  const results = [];
  const allSignals = { totalCandles: 0, totalSignals: 0 };
  let processed = 0;

  const blockReasons = {};
  let holdCount = 0;
  let last15mIndex = 0;
  let last1hIndex = 0;

  for (let i = 0; i < candles5m.length; i++) {
    const candle = candles5m[i];

    engine.currentCandleTime = candle.timestamp;
    engine.addCandle(candle);
    allSignals.totalCandles++;

    // ── Feed 15min candles up to current time (no lookahead) ──
    while (last15mIndex < candles15m.length && candles15m[last15mIndex].timestamp <= candle.timestamp) {
      engine.addMTFCandle(candles15m[last15mIndex]);
      last15mIndex++;
    }

    // ── Feed 1h candles up to current time (no lookahead) ──
    while (last1hIndex < candles1h.length && candles1h[last1hIndex].timestamp <= candle.timestamp) {
      engine.addMacroCandle(candles1h[last1hIndex]);
      last1hIndex++;
    }

    if (i < warmupCandles) continue;

    const signal = engine.analyze(SYMBOL);
    if (!signal) continue;

    if (signal.action === 'HOLD' && signal.warnings?.length > 0) {
      holdCount++;
      for (const w of signal.warnings) {
        const key = w.replace(/[\d.]+/g, 'N').substring(0, 65);
        blockReasons[key] = (blockReasons[key] || 0) + 1;
      }
    }

    if (signal.action !== 'HOLD') {
      allSignals.totalSignals++;

      if (signal.confidence >= MIN_CONFIDENCE) {
        const timeDiff = candle.timestamp - lastSignalTime;
        if (timeDiff < cooldownMs) continue;

        const windowStart = candle.timestamp - clusterWindow;
        const recentSameDir = recentSignals.filter(s =>
          s.action === signal.action && s.timestamp >= windowStart
        );
        if (recentSameDir.length >= maxSameDirectionIn3h) continue;

        // ── Determine Macro action for logging ──
        let macroAction = 'NEUTRAL';
        let macroTrend = 'N/A';
        const macroReason = signal.reasons?.find(r => r.includes('1h macro aligned'));
        const macroWarning = signal.warnings?.find(w => w.includes('1h macro'));
        if (macroReason) {
          macroAction = 'BOOSTED';
          macroTrend = macroReason.includes('bullish') ? 'BULL✅' : 'BEAR✅';
        } else if (macroWarning) {
          macroAction = 'PENALIZED';
          macroTrend = macroWarning.includes('bullish') ? 'BULL⚠️' : 'BEAR⚠️';
        }

        // ── Determine MTF action for logging ──
        let mtfAction = 'NEUTRAL';
        let mtfTrend = 'N/A';
        const mtfReason = signal.reasons?.find(r => r.includes('15min MTF'));
        const mtfWarning = signal.warnings?.find(w => w.includes('15min MTF'));
        if (mtfReason) {
          mtfAction = 'BOOSTED';
          mtfTrend = mtfReason.includes('bullish') ? 'BULL✅' : 'BEAR✅';
        } else if (mtfWarning) {
          mtfAction = 'PENALIZED';
          mtfTrend = mtfWarning.includes('bullish') ? 'BULL⚠️' : 'BEAR⚠️';
        }

        const outcome = simulateOutcome(signal, candles5m, i);
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
            pnlR,
            macroAction,
            macroTrend,
            mtfAction,
            mtfTrend
          });

          recentSignals.push({ action: signal.action, timestamp: candle.timestamp });
          lastSignalTime = candle.timestamp;
        }
      }
    }

    processed++;
    if (processed % 500 === 0) {
      const pct = ((i / candles5m.length) * 100).toFixed(0);
      process.stdout.write(`\r   Progress: ${pct}% | Signals: ${results.length} | 15m: ${last15mIndex} | 1h: ${last1hIndex}`);
    }
  }

  process.stdout.write('\n');

  // ── WHY SIGNALS WERE BLOCKED ──
  console.log(`\n🔍 WHY SIGNALS WERE BLOCKED (${holdCount} HOLDs with warnings):`);
  const sorted = Object.entries(blockReasons).sort((a, b) => b[1] - a[1]).slice(0, 15);
  sorted.forEach(([reason, count]) => {
    const isMacro = reason.includes('macro') || reason.includes('1h');
    const isMTF = reason.includes('MTF') || reason.includes('15min');
    const icon = isMacro ? ' 🏔️' : isMTF ? ' 📈' : '  ';
    console.log(`  ${count}x${icon} — ${reason}`);
  });

  // Save results
  fs.mkdirSync('./data', { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify({
    config: { SYMBOL, DAYS, MIN_CONFIDENCE, TIMEFRAME, mtfEnabled: candles15m.length > 0, macroEnabled: candles1h.length > 0 },
    allSignals,
    results
  }, null, 2));
  console.log(`\n💾 Results saved to: ${OUTPUT_FILE}`);

  const label = `(MTF: ${candles15m.length > 0 ? '✅' : '❌'} | Macro 1h: ${candles1h.length > 0 ? '✅' : '❌'})`;
  printResults(results, allSignals, label);
}

runBacktest().catch(err => {
  console.error('Backtest failed:', err);
  process.exit(1);
});