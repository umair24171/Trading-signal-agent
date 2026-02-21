// ═══════════════════════════════════════════════════════════════════
// RESOLVE_SIGNALS.JS — Auto-check TP/SL outcomes for Discord signals
//
// Usage:
//   node src/resolve_signals.js
//
// What it does:
// 1. Takes all signals from your Discord (hardcoded below)
// 2. Fetches 5min candles from TwelveData for each signal date
// 3. Checks if TP or SL was hit first (up to 48 candles = 4 hours)
// 4. Prints full report + saves to ./data/resolved_signals.json
// ═══════════════════════════════════════════════════════════════════

import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs';
import axios from 'axios';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── ALL SIGNALS FROM DISCORD (Feb 16 onwards, v2 engine only) ──
const SIGNALS = [
  { date: '2026-02-16 23:04', symbol: 'XAU/USD', action: 'SELL', entry: 4989.85, sl: 4994.74, tp: 4983.74, confidence: 81 },
  { date: '2026-02-16 23:24', symbol: 'XAU/USD', action: 'BUY',  entry: 4995.76, sl: 4990.90, tp: 5001.85, confidence: 95 },
  { date: '2026-02-16 23:58', symbol: 'EUR/USD', action: 'SELL', entry: 1.18507, sl: 1.18537, tp: 1.18477, confidence: 59 },
  { date: '2026-02-17 00:44', symbol: 'XAU/USD', action: 'SELL', entry: 4992.40, sl: 4996.69, tp: 4988.10, confidence: 51 },
  { date: '2026-02-17 01:04', symbol: 'EUR/USD', action: 'SELL', entry: 1.18541, sl: 1.18567, tp: 1.18515, confidence: 65 },
  { date: '2026-02-17 16:12', symbol: 'EUR/USD', action: 'SELL', entry: 1.18438, sl: 1.18481, tp: 1.18395, confidence: 51 },
  { date: '2026-02-17 16:22', symbol: 'XAU/USD', action: 'BUY',  entry: 4926.39, sl: 4916.51, tp: 4936.28, confidence: 69 },
  { date: '2026-02-18 11:24', symbol: 'XAU/USD', action: 'BUY',  entry: 4926.48, sl: 4920.07, tp: 4932.88, confidence: 64 },
  { date: '2026-02-18 11:24', symbol: 'XAU/USD', action: 'BUY',  entry: 4931.20, sl: 4924.40, tp: 4941.41, confidence: 64 },
  { date: '2026-02-18 11:55', symbol: 'EUR/USD', action: 'BUY',  entry: 1.18449, sl: 1.18419, tp: 1.18479, confidence: 64 },
  { date: '2026-02-18 13:57', symbol: 'XAU/USD', action: 'BUY',  entry: 4921.14, sl: 4915.22, tp: 4927.06, confidence: 65 },
  { date: '2026-02-18 15:54', symbol: 'EUR/USD', action: 'SELL', entry: 1.18355, sl: 1.18401, tp: 1.18309, confidence: 79 },
  { date: '2026-02-18 20:54', symbol: 'EUR/USD', action: 'SELL', entry: 1.18217, sl: 1.18286, tp: 1.18114, confidence: 83 },
  { date: '2026-02-18 21:19', symbol: 'EUR/USD', action: 'SELL', entry: 1.18182, sl: 1.18261, tp: 1.18103, confidence: 85 },
  { date: '2026-02-18 21:34', symbol: 'XAU/USD', action: 'BUY',  entry: 4995.01, sl: 4987.08, tp: 5006.89, confidence: 79 },
  { date: '2026-02-18 21:34', symbol: 'XAU/USD', action: 'BUY',  entry: 4998.16, sl: 4990.27, tp: 5009.99, confidence: 79 },
  { date: '2026-02-18 23:46', symbol: 'XAU/USD', action: 'BUY',  entry: 4985.07, sl: 4976.69, tp: 4997.63, confidence: 68 },
  { date: '2026-02-19 00:02', symbol: 'XAU/USD', action: 'BUY',  entry: 4986.27, sl: 4978.85, tp: 4997.39, confidence: 60 },
  { date: '2026-02-19 02:09', symbol: 'XAU/USD', action: 'SELL', entry: 4981.20, sl: 4988.48, tp: 4973.92, confidence: 60 },
  { date: '2026-02-19 05:37', symbol: 'EUR/USD', action: 'SELL', entry: 1.17878, sl: 1.17906, tp: 1.17850, confidence: 64 },
  { date: '2026-02-19 08:05', symbol: 'XAU/USD', action: 'SELL', entry: 4967.92, sl: 4974.77, tp: 4961.07, confidence: 64 },
  { date: '2026-02-19 15:07', symbol: 'XAU/USD', action: 'BUY',  entry: 4992.75, sl: 4984.49, tp: 5005.14, confidence: 85 },
  { date: '2026-02-19 15:22', symbol: 'EUR/USD', action: 'BUY',  entry: 1.17931, sl: 1.17876, tp: 1.17986, confidence: 60 },
  { date: '2026-02-19 19:05', symbol: 'XAU/USD', action: 'SELL', entry: 4987.53, sl: 4997.64, tp: 4972.35, confidence: 73 },
  { date: '2026-02-19 20:27', symbol: 'EUR/USD', action: 'SELL', entry: 1.17653, sl: 1.17758, tp: 1.17496, confidence: 62 },
  { date: '2026-02-19 22:39', symbol: 'EUR/USD', action: 'BUY',  entry: 1.17666, sl: 1.17587, tp: 1.17745, confidence: 62 },
  { date: '2026-02-20 16:12', symbol: 'XAU/USD', action: 'BUY',  entry: 5034.19, sl: 5026.10, tp: 5042.28, confidence: 65 },
  { date: '2026-02-21 01:07', symbol: 'XAU/USD', action: 'SELL', entry: 5077.76, sl: 5089.50, tp: 5060.15, confidence: 57 },
];

// ── FETCH 5MIN CANDLES AFTER A GIVEN TIMESTAMP ──
async function fetchCandlesAfter(symbol, fromDateStr) {
  const cacheDir = './data/historical';
  fs.mkdirSync(cacheDir, { recursive: true });

  const cacheKey = `${symbol.replace('/', '')}_resolve_${fromDateStr.replace(/[: ]/g, '_')}`;
  const cacheFile = `${cacheDir}/${cacheKey}.json`;

  if (fs.existsSync(cacheFile)) {
    return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  }

  console.log(`   📡 Fetching candles for ${symbol} from ${fromDateStr}...`);

  try {
    const response = await axios.get('https://api.twelvedata.com/time_series', {
      params: {
        symbol,
        interval: '5min',
        outputsize: 60, // 60 candles = 5 hours, enough to resolve any signal
        apikey: process.env.TWELVE_DATA_API_KEY
      },
      timeout: 15000
    });

    if (response.data.status === 'error') {
      console.error(`   ❌ API Error: ${response.data.message}`);
      return [];
    }

    const candles = (response.data.values || [])
      .reverse()
      .map(v => ({
        timestamp: new Date(v.datetime).getTime(),
        open: parseFloat(v.open),
        high: parseFloat(v.high),
        low: parseFloat(v.low),
        close: parseFloat(v.close),
      }));

    fs.writeFileSync(cacheFile, JSON.stringify(candles));
    return candles;

  } catch (err) {
    console.error(`   ❌ Fetch error: ${err.message}`);
    return [];
  }
}

// ── RESOLVE OUTCOME FROM CANDLES ──
function resolveOutcome(signal, candles) {
  const signalTime = new Date(signal.date + ' UTC').getTime();

  // Only look at candles AFTER signal time
  const futureCandles = candles.filter(c => c.timestamp > signalTime).slice(0, 48);

  if (futureCandles.length === 0) {
    return { outcome: 'NO_DATA', candlesHeld: 0, exitPrice: null, pnlR: null };
  }

  for (let i = 0; i < futureCandles.length; i++) {
    const c = futureCandles[i];

    if (signal.action === 'BUY') {
      if (c.high >= signal.tp) {
        const risk = Math.abs(signal.entry - signal.sl);
        return { outcome: 'WIN', candlesHeld: i + 1, exitPrice: signal.tp, pnlR: parseFloat((Math.abs(signal.tp - signal.entry) / risk).toFixed(2)) };
      }
      if (c.low <= signal.sl) {
        const risk = Math.abs(signal.entry - signal.sl);
        return { outcome: 'LOSS', candlesHeld: i + 1, exitPrice: signal.sl, pnlR: parseFloat((-Math.abs(signal.sl - signal.entry) / risk).toFixed(2)) };
      }
    } else { // SELL
      if (c.low <= signal.tp) {
        const risk = Math.abs(signal.sl - signal.entry);
        return { outcome: 'WIN', candlesHeld: i + 1, exitPrice: signal.tp, pnlR: parseFloat((Math.abs(signal.entry - signal.tp) / risk).toFixed(2)) };
      }
      if (c.high >= signal.sl) {
        const risk = Math.abs(signal.sl - signal.entry);
        return { outcome: 'LOSS', candlesHeld: i + 1, exitPrice: signal.sl, pnlR: parseFloat((-Math.abs(signal.sl - signal.entry) / risk).toFixed(2)) };
      }
    }
  }

  // Neither hit in 48 candles
  const lastClose = futureCandles[futureCandles.length - 1].close;
  const risk = Math.abs(signal.entry - signal.sl);
  const pnl = (signal.action === 'BUY' ? lastClose - signal.entry : signal.entry - lastClose) / risk;
  return { outcome: 'EXPIRED', candlesHeld: futureCandles.length, exitPrice: lastClose, pnlR: parseFloat(pnl.toFixed(2)) };
}

// ── PRINT FULL REPORT ──
function printReport(resolved) {
  console.log('\n' + '═'.repeat(70));
  console.log('📊 DISCORD SIGNALS — RESOLVED OUTCOMES');
  console.log('═'.repeat(70));

  const valid = resolved.filter(r => r.outcome !== 'NO_DATA');
  const wins = valid.filter(r => r.outcome === 'WIN');
  const losses = valid.filter(r => r.outcome === 'LOSS');
  const expired = valid.filter(r => r.outcome === 'EXPIRED');
  const totalR = valid.reduce((s, r) => s + (r.pnlR || 0), 0);
  const winRate = valid.length > 0 ? ((wins.length / valid.length) * 100).toFixed(1) : 0;

  console.log(`\nTotal signals: ${resolved.length} | Resolved: ${valid.length} | No data: ${resolved.length - valid.length}`);
  console.log(`✅ WINS: ${wins.length} | ❌ LOSSES: ${losses.length} | ⏰ EXPIRED: ${expired.length}`);
  console.log(`📈 Win Rate: ${winRate}%`);
  console.log(`💰 Total P&L: ${totalR >= 0 ? '+' : ''}${totalR.toFixed(2)}R`);

  // By symbol
  console.log('\n📊 By Symbol:');
  const symbols = [...new Set(valid.map(r => r.symbol))];
  for (const sym of symbols) {
    const s = valid.filter(r => r.symbol === sym);
    const w = s.filter(r => r.outcome === 'WIN').length;
    const sR = s.reduce((acc, r) => acc + (r.pnlR || 0), 0);
    console.log(`  ${sym}: ${s.length} signals | ${((w/s.length)*100).toFixed(0)}% WR | ${sR >= 0 ? '+' : ''}${sR.toFixed(2)}R`);
  }

  // By action
  console.log('\n📊 By Direction:');
  const buys = valid.filter(r => r.action === 'BUY');
  const sells = valid.filter(r => r.action === 'SELL');
  if (buys.length) {
    const bw = buys.filter(r => r.outcome === 'WIN').length;
    const bR = buys.reduce((s, r) => s + (r.pnlR || 0), 0);
    console.log(`  BUY:  ${buys.length} signals | ${((bw/buys.length)*100).toFixed(0)}% WR | ${bR >= 0 ? '+' : ''}${bR.toFixed(2)}R`);
  }
  if (sells.length) {
    const sw = sells.filter(r => r.outcome === 'WIN').length;
    const sR = sells.reduce((s, r) => s + (r.pnlR || 0), 0);
    console.log(`  SELL: ${sells.length} signals | ${((sw/sells.length)*100).toFixed(0)}% WR | ${sR >= 0 ? '+' : ''}${sR.toFixed(2)}R`);
  }

  // By confidence band
  console.log('\n📊 By Confidence:');
  const bands = [
    { label: '80%+',   filter: r => r.confidence >= 80 },
    { label: '70-79%', filter: r => r.confidence >= 70 && r.confidence < 80 },
    { label: '60-69%', filter: r => r.confidence >= 60 && r.confidence < 70 },
    { label: '<60%',   filter: r => r.confidence < 60 },
  ];
  for (const band of bands) {
    const b = valid.filter(band.filter);
    if (!b.length) continue;
    const bw = b.filter(r => r.outcome === 'WIN').length;
    const bR = b.reduce((s, r) => s + (r.pnlR || 0), 0);
    console.log(`  ${band.label}: ${b.length} signals | ${((bw/b.length)*100).toFixed(0)}% WR | ${bR >= 0 ? '+' : ''}${bR.toFixed(2)}R`);
  }

  // Full signal table
  console.log('\n📋 All Signals:');
  console.log('  Date            | Sym     | Act  | Conf | Outcome | P&L   | Mins');
  console.log('  ----------------|---------|------|------|---------|-------|-----');
  for (const r of resolved) {
    const date = r.date.slice(5); // MM-DD HH:MM
    const sym = r.symbol.padEnd(7);
    const outcome = (r.outcome || 'NO_DATA').padEnd(7);
    const pnl = r.pnlR !== null ? (r.pnlR >= 0 ? `+${r.pnlR}R` : `${r.pnlR}R`) : 'N/A';
    const mins = r.candlesHeld ? `${r.candlesHeld * 5}m` : 'N/A';
    console.log(`  ${date} | ${sym} | ${r.action.padEnd(4)} | ${r.confidence}% | ${outcome} | ${pnl.padEnd(5)} | ${mins}`);
  }

  console.log('\n' + '═'.repeat(70));
}

// ── MAIN ──
async function main() {
  console.log('\n🔍 AUTO-RESOLVING DISCORD SIGNALS...\n');

  // Group signals by symbol to minimize API calls
  const symbolGroups = {};
  for (const sig of SIGNALS) {
    if (!symbolGroups[sig.symbol]) symbolGroups[sig.symbol] = [];
    symbolGroups[sig.symbol].push(sig);
  }

  const resolved = [];

  for (const [symbol, signals] of Object.entries(symbolGroups)) {
    console.log(`\n📊 Processing ${symbol} (${signals.length} signals)...`);

    // Fetch candles once per symbol (gets latest ~60 candles)
    // For older signals we need separate fetches — API doesn't support date ranges on free tier
    // So we fetch per signal with caching to avoid wasting credits
    for (const signal of signals) {
      const candles = await fetchCandlesAfter(signal.symbol, signal.date);
      const result = resolveOutcome(signal, candles);

      resolved.push({ ...signal, ...result });

      const emoji = result.outcome === 'WIN' ? '✅' : result.outcome === 'LOSS' ? '❌' : result.outcome === 'EXPIRED' ? '⏰' : '❓';
      console.log(`  ${emoji} ${signal.date} ${signal.action} @ ${signal.entry} → ${result.outcome} (${result.pnlR !== null ? (result.pnlR >= 0 ? '+' : '') + result.pnlR + 'R' : 'no data'})`);

      await sleep(10000); // 10 seconds — stays within 8 calls/min
    }
  }

  // Save results
  fs.mkdirSync('./data', { recursive: true });
  fs.writeFileSync('./data/resolved_signals.json', JSON.stringify(resolved, null, 2));
  console.log('\n💾 Saved to ./data/resolved_signals.json');

  printReport(resolved);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});