const fs = require('fs');
let code = fs.readFileSync('src/engine/SignalEngine.js', 'utf8');

const oldMacro = /\/\/ ── MACRO TREND FILTER[\s\S]*?\/\/ ── VOLATILITY EXPANSION/;

const newMacro = `// ── MACRO TREND FILTER (v3) ──
      // EMA/SMA on 5min trail price too closely — useless for catching week-long trends
      // Raw price change over last 100 candles (8.3h) captures actual directional bias
      const allCloses = this.candleStore.get(symbol).map(c => c.close);
      const macroLookback = 100;
      const macroStart = allCloses.length > macroLookback ? allCloses[allCloses.length - 1 - macroLookback] : null;
      const macroPct = macroStart ? ((currentPrice - macroStart) / macroStart) * 100 : 0;

      if (action === 'SELL' && macroPct > 0.5) {
        return this.holdResult(symbol, currentPrice, ind, ctx, momentum,
          ['BLOCKED: +' + macroPct.toFixed(2) + '% last 8h — macro bull, no shorts']);
      }
      if (action === 'BUY' && macroPct < -0.5) {
        return this.holdResult(symbol, currentPrice, ind, ctx, momentum,
          ['BLOCKED: ' + macroPct.toFixed(2) + '% last 8h — macro bear, no buys']);
      }
      if (action === 'SELL' && macroPct > 0.2) {
        confidence = Math.round(confidence * 0.75);
        warnings.push('Weak macro bull (+' + macroPct.toFixed(2) + '% 8h)');
      }
      if (action === 'BUY' && macroPct < -0.2) {
        confidence = Math.round(confidence * 0.75);
        warnings.push('Weak macro bear (' + macroPct.toFixed(2) + '% 8h)');
      }
      if (action === 'BUY' && macroPct > 0.2) confidence = Math.min(Math.round(confidence * 1.08), 90);
      if (action === 'SELL' && macroPct < -0.2) confidence = Math.min(Math.round(confidence * 1.08), 90);

      // ── VOLATILITY EXPANSION`;

if (oldMacro.test(code)) {
  code = code.replace(oldMacro, newMacro);
  fs.writeFileSync('src/engine/SignalEngine.js', code);
  console.log('✅ Macro filter v3 patched successfully');
} else {
  console.log('❌ Pattern not found — showing current macro section:');
  const idx = code.indexOf('MACRO TREND');
  if (idx >= 0) console.log(code.substring(idx - 5, idx + 300));
  else console.log('MACRO TREND string not found in file at all!');
}
