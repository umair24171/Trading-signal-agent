const fs = require('fs');
let code = fs.readFileSync('src/engine/SignalEngine.js', 'utf8');

// Remove macro filter + volatility expansion filter (they killed our only WIN)
// Revert to clean state before all the macro filter experiments
const macroBlock = /\/\/ ── MACRO TREND FILTER \(v3\)[\s\S]*?\/\/ ── VOLATILITY EXPANSION FILTER[\s\S]*?}\s*}/;

const revertedBlock = `// ── NOTE: Macro filter removed — caused more harm than good on 9-signal sample
      // Will tune after collecting 50+ live signals with real outcomes`;

if (macroBlock.test(code)) {
  code = code.replace(macroBlock, revertedBlock);
  fs.writeFileSync('src/engine/SignalEngine.js', code);
  console.log('✅ Macro/volatility filters removed');
} else {
  console.log('❌ Pattern not found — trying alternative...');
  // Show what's around MACRO TREND
  const idx = code.indexOf('MACRO TREND');
  if (idx >= 0) console.log(code.substring(idx - 10, idx + 400));
  else console.log('No MACRO TREND found in file');
}
