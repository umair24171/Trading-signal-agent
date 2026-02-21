const fs = require('fs');
let code = fs.readFileSync('src/engine/SignalEngine.js', 'utf8');
let changed = 0;

// ── FIX 1: Minimum ATR guard — block ultra-squeeze before any signal ──
// XAU/USD 5min normal ATR: $3-15. If ATR < $2, market is dead, don't trade.
// This alone would have blocked signals 4, 5, 6 (ATR was $0.24)
const oldATRGuard = /\/\/ ── SL\/TP CALCULATION ──/;
const newATRGuard = `// ── ATR MINIMUM GUARD ──
    // XAU/USD: if ATR < $2, volatility is too low to produce clean moves
    // Signals 4,5,6 had ATR of $0.24 — essentially untradeable noise level
    if (symbol.includes('XAU') && atrValue < 2.0) {
      return this.holdResult(symbol, currentPrice, ind, ctx, momentum,
        [\`ATR too low ($\${atrValue.toFixed(2)}) — ultra-squeeze, not tradeable\`]);
    }
    if (symbol.includes('BTC') && atrValue < 50) {
      return this.holdResult(symbol, currentPrice, ind, ctx, momentum,
        [\`ATR too low ($\${atrValue.toFixed(2)}) — ultra-squeeze, not tradeable\`]);
    }

    // ── SL/TP CALCULATION ──`;

if (oldATRGuard.test(code)) {
  code = code.replace(oldATRGuard, newATRGuard);
  changed++;
  console.log('✅ Fix 1: ATR minimum guard added');
} else {
  console.log('❌ Fix 1 failed — could not find SL/TP section');
}

// ── FIX 2: Block OFF_HOURS signals ──
// Signal 9 was OFF_HOURS with $33 SL — dead market, wide spreads, unpredictable
const oldOffHours = /else if \(ctx\.session === 'ASIAN'\) \{ confidence = Math\.round\(confidence \* 0\.85\); warnings\.push\('Asian session \(-15%\)'\); \}/;
const newOffHours = `else if (ctx.session === 'ASIAN') { confidence = Math.round(confidence * 0.85); warnings.push('Asian session (-15%)'); }
      else if (ctx.session === 'OFF_HOURS') {
        return this.holdResult(symbol, currentPrice, ind, ctx, momentum, ['OFF_HOURS session — market closed/dead, no trading']);
      }`;

if (oldOffHours.test(code)) {
  code = code.replace(oldOffHours, newOffHours);
  changed++;
  console.log('✅ Fix 2: OFF_HOURS block added');
} else {
  console.log('❌ Fix 2 failed — could not find Asian session line');
}

// ── FIX 3: Block when ADX returns 0 (calculation error) ──
// Signals 8 & 9 had ADX = 0.0 — this is a broken indicator read
const oldADXCheck = /const adxValue = ind\.adx\?\.adx \|\| 0;/;
const newADXCheck = `const adxValue = ind.adx?.adx || 0;
    // Block if ADX is 0 — this indicates a calculation error, not a valid read
    if (action !== 'HOLD' && adxValue === 0) {
      return this.holdResult(symbol, currentPrice, ind, ctx, momentum,
        ['ADX calculation error (returned 0) — skipping signal']);
    }`;

if (oldADXCheck.test(code)) {
  code = code.replace(oldADXCheck, newADXCheck);
  changed++;
  console.log('✅ Fix 3: ADX=0 guard added');
} else {
  console.log('❌ Fix 3 failed — could not find ADX check line');
}

if (changed > 0) {
  fs.writeFileSync('src/engine/SignalEngine.js', code);
  console.log(`\n✅ ${changed}/3 fixes applied successfully`);
  console.log('\nNow run:');
  console.log('  node src/backtest.js --symbol XAU/USD --days 30');
} else {
  console.log('\n❌ No fixes applied');
}
