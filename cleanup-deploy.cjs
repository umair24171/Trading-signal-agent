const fs = require('fs');

// Clean backtest.js debug logs
let bt = fs.readFileSync('src/backtest.js', 'utf8');
bt = bt.replace(/\s*console\.log\(`🔖 Engine version check.*?\n/, '\n');
bt = bt.replace(/\s*\/\/ Debug: print EMA100.*?\n.*?console\.log\(`.*?EMA100.*?\n.*?}\n/, '\n');
fs.writeFileSync('src/backtest.js', bt);
console.log('✅ backtest.js debug logs cleaned');

// Clean SignalEngine - remove old macro comment clutter
let se = fs.readFileSync('src/engine/SignalEngine.js', 'utf8');
se = se.replace(
  /\s*\/\/ MACRO TREND FILTER \(replaces broken entry candle filter\)[\s\S]*?\/\/ Fix: Require the triggering candle[\s\S]*?\/\/ ── CONTEXT ADJUSTMENTS ──/,
  '\n    // ── CONTEXT ADJUSTMENTS ──'
);
fs.writeFileSync('src/engine/SignalEngine.js', se);
console.log('✅ SignalEngine.js comments cleaned');

console.log('\n🚀 Ready to deploy! Run:');
console.log('   git add -A');
console.log('   git commit -m "v7: WinRateTracker + SRDetector - live data collection"');
console.log('   git push');
