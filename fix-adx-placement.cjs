const fs = require('fs');
let code = fs.readFileSync('src/engine/SignalEngine.js', 'utf8');

// Remove the misplaced ADX=0 guard from getContext (where action doesn't exist)
const badADX = /\s*\/\/ Block if ADX is 0[\s\S]*?}\n/;
code = code.replace(badADX, '\n');
console.log('✅ Removed misplaced ADX guard from getContext');

// Place it correctly — after action is determined, before SL/TP calculation
// Find the ATR minimum guard we added and insert ADX check before it
const oldATRGuard = /\/\/ ── ATR MINIMUM GUARD ──/;
const newGuard = `// ── ADX=0 GUARD (calculation error check) ──
    // ADX returning 0 means indicator calculation failed — skip signal
    if (action !== 'HOLD') {
      const adxCheck = ind.adx?.adx || 0;
      if (adxCheck === 0 && action !== 'HOLD') {
        return this.holdResult(symbol, currentPrice, ind, ctx, momentum,
          ['ADX calculation error (returned 0) — skipping signal']);
      }
    }

    // ── ATR MINIMUM GUARD ──`;

if (oldATRGuard.test(code)) {
  code = code.replace(oldATRGuard, newGuard);
  fs.writeFileSync('src/engine/SignalEngine.js', code);
  console.log('✅ ADX guard placed correctly before SL/TP calculation');
  console.log('\nRun: node src/backtest.js --symbol XAU/USD --days 30');
} else {
  console.log('❌ Could not find ATR MINIMUM GUARD anchor');
}
