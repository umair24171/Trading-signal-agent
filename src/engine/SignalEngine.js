import { RSI, MACD, EMA, SMA, BollingerBands, ATR, Stochastic, ADX, CCI } from 'technicalindicators';

export class SignalEngine {
  constructor(config = {}) {
    this.candleStore = new Map();
    this.minConfluence = config.minConfluence || 3;
    this.minRR = config.minRR || 1.5;
  }

  loadHistoricalCandles(symbol, candles) {
    this.candleStore.set(symbol, [...candles]);
    console.log(`   📊 SignalEngine: Loaded ${candles.length} historical candles for ${symbol}`);
  }

  addCandle(candle) {
    if (!this.candleStore.has(candle.symbol)) this.candleStore.set(candle.symbol, []);
    const store = this.candleStore.get(candle.symbol);
    const last = store[store.length - 1];
    if (last && last.timestamp === candle.timestamp) store[store.length - 1] = candle;
    else { store.push(candle); if (store.length > 300) store.shift(); }
  }

  analyze(symbol) {
    const candles = this.candleStore.get(symbol);
    if (!candles || candles.length < 60) return null;
    const closes = candles.map(c => c.close);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const opens = candles.map(c => c.open);
    const ind = this.calcIndicators(closes, highs, lows, opens);
    if (!ind) return null;
    const ctx = this.getContext(ind, closes, highs, lows);

    // v6: Analyze momentum from raw candle data
    const momentum = this.analyzeMomentum(candles, ind);

    return this.generateSignal(symbol, ind, ctx, momentum, closes[closes.length - 1]);
  }

  calcIndicators(closes, highs, lows, opens) {
    try {
      const rsi = RSI.calculate({ values: closes, period: 14 });
      const macd = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false });
      const ema9 = EMA.calculate({ values: closes, period: 9 });
      const ema21 = EMA.calculate({ values: closes, period: 21 });
      const ema50 = EMA.calculate({ values: closes, period: 50 });
      const sma200 = SMA.calculate({ values: closes, period: Math.min(200, closes.length - 1) });
      const bb = BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 });
      const atr = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
      const atr7 = ATR.calculate({ high: highs, low: lows, close: closes, period: 7 });
      const stoch = Stochastic.calculate({ high: highs, low: lows, close: closes, period: 14, signalPeriod: 3 });
      const adx = ADX.calculate({ high: highs, low: lows, close: closes, period: 14 });
      const cci = CCI.calculate({ high: highs, low: lows, close: closes, period: 20 });

      return {
        price: closes[closes.length - 1], prevPrice: closes[closes.length - 2],
        rsi: rsi[rsi.length - 1], rsiPrev: rsi[rsi.length - 2],
        // Store last 6 RSI values for momentum persistence
        rsiHistory: rsi.slice(-6),
        macd: macd[macd.length - 1], macdPrev: macd[macd.length - 2],
        macdPrev2: macd.length > 2 ? macd[macd.length - 3] : null,
        ema9: ema9[ema9.length - 1], ema21: ema21[ema21.length - 1], ema50: ema50[ema50.length - 1],
        sma200: sma200.length > 0 ? sma200[sma200.length - 1] : null,
        ema9Prev: ema9[ema9.length - 2], ema21Prev: ema21[ema21.length - 2],
        bb: bb[bb.length - 1],
        atr: atr[atr.length - 1], atr7: atr7.length > 0 ? atr7[atr7.length - 1] : atr[atr.length - 1],
        atrPrev: atr.length > 5 ? atr[atr.length - 5] : atr[atr.length - 1],
        stoch: stoch[stoch.length - 1], stochPrev: stoch.length > 1 ? stoch[stoch.length - 2] : null,
        // Store last 6 Stoch values for momentum persistence
        stochHistory: stoch.slice(-6),
        adx: adx[adx.length - 1],
        cci: cci[cci.length - 1], cciPrev: cci.length > 1 ? cci[cci.length - 2] : null,
        recentHighs: highs.slice(-30), recentLows: lows.slice(-30), recentCloses: closes.slice(-30)
      };
    } catch (err) { console.error('Indicator error:', err.message); return null; }
  }

  // ═══════════════════════════════════════════════════════════════
  // v6 NEW: MOMENTUM ANALYZER
  //
  // Analyzes raw candle data to detect:
  // 1. Price structure (Higher Highs/Higher Lows or Lower Highs/Lower Lows)
  // 2. Candle momentum (consecutive bullish/bearish candles)
  // 3. Move size (how far price has moved recently vs ATR)
  // 4. Momentum persistence (oscillators stuck in extreme zones)
  // ═══════════════════════════════════════════════════════════════
  analyzeMomentum(candles, ind) {
    const recent = candles.slice(-8); // Last 8 candles
    const momentum = {
      bullishCandles: 0,     // consecutive bullish candles
      bearishCandles: 0,     // consecutive bearish candles
      higherHighs: 0,        // count of higher highs
      higherLows: 0,         // count of higher lows
      lowerHighs: 0,         // count of lower highs
      lowerLows: 0,          // count of lower lows
      priceStructure: 'NONE', // BULLISH_STRUCTURE, BEARISH_STRUCTURE, NONE
      stochPersistence: 'NONE', // OVERBOUGHT_PERSISTENT, OVERSOLD_PERSISTENT, NONE
      rsiPersistence: 'NONE',
      moveSize: 0,           // how far price moved in last 8 candles vs ATR
      isMomentumMove: false  // is this a strong directional move
    };

    // 1. Consecutive candle direction
    for (let i = recent.length - 1; i >= 0; i--) {
      if (recent[i].close > recent[i].open) {
        if (momentum.bearishCandles > 0) break; // streak broken
        momentum.bullishCandles++;
      } else {
        if (momentum.bullishCandles > 0) break;
        momentum.bearishCandles++;
      }
    }

    // 2. Price structure - check last 6 candles for HH/HL or LH/LL
    for (let i = 2; i < recent.length; i++) {
      if (recent[i].high > recent[i-1].high) momentum.higherHighs++;
      else if (recent[i].high < recent[i-1].high) momentum.lowerHighs++;

      if (recent[i].low > recent[i-1].low) momentum.higherLows++;
      else if (recent[i].low < recent[i-1].low) momentum.lowerLows++;
    }

    if (momentum.higherHighs >= 3 && momentum.higherLows >= 3)
      momentum.priceStructure = 'BULLISH_STRUCTURE';
    else if (momentum.lowerHighs >= 3 && momentum.lowerLows >= 3)
      momentum.priceStructure = 'BEARISH_STRUCTURE';

    // 3. Move size relative to ATR
    if (recent.length >= 2 && ind.atr) {
      const moveSize = Math.abs(recent[recent.length - 1].close - recent[0].open);
      const atrMultiple = moveSize / ind.atr;
      momentum.moveSize = atrMultiple;

      // If price moved more than 3x ATR in 8 candles, it's a momentum move
      if (atrMultiple > 3) momentum.isMomentumMove = true;
    }

    // 4. Stochastic persistence — is stoch stuck in overbought/oversold?
    if (ind.stochHistory && ind.stochHistory.length >= 4) {
      const lastFour = ind.stochHistory.slice(-4);
      const allOverbought = lastFour.every(s => s.k > 75);
      const allOversold = lastFour.every(s => s.k < 25);
      if (allOverbought) momentum.stochPersistence = 'OVERBOUGHT_PERSISTENT';
      if (allOversold) momentum.stochPersistence = 'OVERSOLD_PERSISTENT';
    }

    // 5. RSI persistence
    if (ind.rsiHistory && ind.rsiHistory.length >= 4) {
      const lastFour = ind.rsiHistory.slice(-4);
      const allHigh = lastFour.every(r => r > 60);
      const allLow = lastFour.every(r => r < 40);
      if (allHigh) momentum.rsiPersistence = 'HIGH_PERSISTENT';
      if (allLow) momentum.rsiPersistence = 'LOW_PERSISTENT';
    }

    return momentum;
  }

  getContext(ind, closes, highs, lows) {
    const ctx = { trend: 'NEUTRAL', trendStrength: 0, volatility: 'NORMAL', session: 'OFF_HOURS', regime: 'RANGING', sr: { support: 0, resistance: 0 } };

    // Trend — ADX must be >= 20
    let ts = 0;
    if (ind.price > ind.ema50) ts++;
    if (ind.sma200 && ind.price > ind.sma200) ts++;
    if (ind.ema9 > ind.ema21) ts++;
    if (ind.ema21 > ind.ema50) ts++;
    const adxValue = ind.adx?.adx || 0;
    if (adxValue >= 20) {
      if (ts >= 3) { ctx.trend = 'BULLISH'; ctx.trendStrength = adxValue; }
      else if (ts <= 1) { ctx.trend = 'BEARISH'; ctx.trendStrength = adxValue; }
    }

    // Volatility
    if (ind.atr7 && ind.atrPrev) {
      const r = ind.atr7 / ind.atrPrev;
      if (r > 1.5) ctx.volatility = 'HIGH';
      else if (r < 0.7) ctx.volatility = 'LOW';
    }
    if (ind.bb) { const w = (ind.bb.upper - ind.bb.lower) / ind.bb.middle; if (w < 0.005) ctx.volatility = 'SQUEEZE'; }

    // Session
    const h = new Date().getUTCHours();
    if (h >= 12 && h < 16) ctx.session = 'OVERLAP';
    else if (h >= 7 && h < 16) ctx.session = 'LONDON';
    else if (h >= 12 && h < 21) ctx.session = 'NEW_YORK';
    else if (h >= 23 || h < 8) ctx.session = 'ASIAN';

    // Regime
    if (adxValue >= 25) ctx.regime = 'TRENDING';
    const rH = Math.max(...highs.slice(-20, -1));
    const rL = Math.min(...lows.slice(-20, -1));
    if ((ind.price > rH || ind.price < rL) && adxValue >= 20) ctx.regime = 'BREAKOUT';

    // S/R
    ctx.sr = this.findSR(closes, highs, lows);
    return ctx;
  }

  findSR(closes, highs, lows) {
    const lb = Math.min(50, highs.length);
    const rh = highs.slice(-lb), rl = lows.slice(-lb);
    const price = closes[closes.length - 1];
    const sH = [], sL = [];
    for (let i = 2; i < lb - 2; i++) {
      if (rh[i] > rh[i-1] && rh[i] > rh[i-2] && rh[i] > rh[i+1] && rh[i] > rh[i+2]) sH.push(rh[i]);
      if (rl[i] < rl[i-1] && rl[i] < rl[i-2] && rl[i] < rl[i+1] && rl[i] < rl[i+2]) sL.push(rl[i]);
    }
    return {
      resistance: sH.filter(v => v > price).sort((a,b) => a-b)[0] || Math.max(...rh),
      support: sL.filter(v => v < price).sort((a,b) => b-a)[0] || Math.min(...rl)
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // SIGNAL ENGINE v6 — SUPERPOWERS
  //
  // ALL FIXES COMBINED:
  //
  // From v4: Strong/weak events, MACD direction conflict, neutral
  //          momentum block, no double counting
  //
  // From v5: S/R proximity, ADX min 20, min R:R 1.5, ranging block
  //
  // NEW v6:
  //
  // 1. MOMENTUM PERSISTENCE BLOCK
  //    Stoch stuck >75 for 4+ candles = momentum, NOT reversal
  //    Don't sell because "overbought" during a momentum move
  //    → This would have blocked the 5078 sell signal
  //
  // 2. PRICE STRUCTURE CHECK
  //    3+ Higher Highs + Higher Lows = bullish structure → don't sell
  //    3+ Lower Highs + Lower Lows = bearish structure → don't buy
  //    → Gold was making HH/HL all the way up, should never sell
  //
  // 3. CANDLE MOMENTUM CHECK
  //    3+ consecutive bullish candles = buyers in control → don't sell
  //    3+ consecutive bearish candles = sellers in control → don't buy
  //    → 5+ green candles in a row = don't fight it
  //
  // 4. LARGE MOVE PROTECTION
  //    If price moved 3+ ATR in last 8 candles = strong momentum
  //    Disable mean-reversion signals (only allow WITH-momentum)
  //    → $50 gold move in hours = momentum, not "overbought"
  //
  // 5. STOCH CROSSOVER IN MOMENTUM = WEAK, NOT STRONG
  //    Stoch crossover when persistence detected = downgraded
  //    → Stoch crossing in overbought during rally = noise
  // ═══════════════════════════════════════════════════════════════
  generateSignal(symbol, ind, ctx, momentum, currentPrice) {
    const buyStrong = [], sellStrong = [];
    const buyWeak = [], sellWeak = [];
    const buyState = [], sellState = [];
    const conflicts = [];
    const eventSources = new Set();

    // ─── STRONG EVENTS ───

    // EMA 9/21 crossover
    if (ind.ema9 > ind.ema21 && ind.ema9Prev <= ind.ema21Prev) {
      buyStrong.push('EMA 9/21 bullish crossover'); eventSources.add('ema');
    } else if (ind.ema9 < ind.ema21 && ind.ema9Prev >= ind.ema21Prev) {
      sellStrong.push('EMA 9/21 bearish crossover'); eventSources.add('ema');
    }

    // MACD crossover
    if (ind.macd && ind.macdPrev) {
      if (ind.macd.MACD > ind.macd.signal && ind.macdPrev.MACD <= ind.macdPrev.signal) {
        buyStrong.push('MACD bullish crossover'); eventSources.add('macd');
      } else if (ind.macd.MACD < ind.macd.signal && ind.macdPrev.MACD >= ind.macdPrev.signal) {
        sellStrong.push('MACD bearish crossover'); eventSources.add('macd');
      }
    }

    // Stochastic crossover in extreme zones
    // v6 CHANGE: If momentum persistence detected, DOWNGRADE to weak event
    if (ind.stoch && ind.stochPrev) {
      if (ind.stoch.k < 20 && ind.stoch.k > ind.stoch.d && ind.stochPrev.k <= ind.stochPrev.d) {
        if (momentum.stochPersistence === 'OVERSOLD_PERSISTENT') {
          buyWeak.push('Stoch bullish crossover (persistent oversold — downgraded)');
        } else {
          buyStrong.push('Stochastic bullish crossover (oversold)');
        }
        eventSources.add('stoch');
      } else if (ind.stoch.k > 80 && ind.stoch.k < ind.stoch.d && ind.stochPrev.k >= ind.stochPrev.d) {
        if (momentum.stochPersistence === 'OVERBOUGHT_PERSISTENT') {
          sellWeak.push('Stoch bearish crossover (persistent overbought — downgraded)');
        } else {
          sellStrong.push('Stochastic bearish crossover (overbought)');
        }
        eventSources.add('stoch');
      }
    }

    // ─── WEAK EVENTS ───

    if (ind.cci !== undefined && ind.cciPrev !== undefined) {
      if (ind.cci > -100 && ind.cciPrev <= -100) { buyWeak.push('CCI crossing above -100'); eventSources.add('cci'); }
      else if (ind.cci < 100 && ind.cciPrev >= 100) { sellWeak.push('CCI crossing below 100'); eventSources.add('cci'); }
    }

    const rHigh = Math.max(...ind.recentHighs.slice(0, -1));
    const rLow = Math.min(...ind.recentLows.slice(0, -1));
    if (ind.price > rHigh && ind.adx && ind.adx.adx > 22) {
      buyWeak.push('Breakout above recent high'); eventSources.add('breakout');
    } else if (ind.price < rLow && ind.adx && ind.adx.adx > 22) {
      sellWeak.push('Breakdown below recent low'); eventSources.add('breakout');
    }

    if (ind.rsi && ind.rsiPrev) {
      if (ind.rsi > 30 && ind.rsiPrev <= 30) { buyWeak.push('RSI exiting oversold'); eventSources.add('rsi'); }
      else if (ind.rsi < 70 && ind.rsiPrev >= 70) { sellWeak.push('RSI exiting overbought'); eventSources.add('rsi'); }
    }

    // ─── STATE SIGNALS (no double counting) ───

    if (!eventSources.has('ema')) {
      if (ind.ema9 > ind.ema21 && ind.ema21 > ind.ema50) buyState.push('EMA bullish alignment (9>21>50)');
      else if (ind.ema9 < ind.ema21 && ind.ema21 < ind.ema50) sellState.push('EMA bearish alignment (9<21<50)');
    }

    if (ind.price > ind.ema21 && ind.price > ind.ema50) buyState.push('Price above EMA 21 & 50');
    else if (ind.price < ind.ema21 && ind.price < ind.ema50) sellState.push('Price below EMA 21 & 50');

    if (!eventSources.has('macd') && ind.macd) {
      if (ind.macd.MACD > ind.macd.signal && ind.macd.histogram > 0) buyState.push('MACD bullish');
      else if (ind.macd.MACD < ind.macd.signal && ind.macd.histogram < 0) sellState.push('MACD bearish');
    }

    if (!eventSources.has('macd') && ind.macd && ind.macdPrev && ind.macdPrev2) {
      if (ind.macd.histogram > ind.macdPrev.histogram && ind.macdPrev.histogram > ind.macdPrev2.histogram && ind.macd.histogram > 0)
        buyState.push('MACD momentum building');
      else if (ind.macd.histogram < ind.macdPrev.histogram && ind.macdPrev.histogram < ind.macdPrev2.histogram && ind.macd.histogram < 0)
        sellState.push('MACD sell momentum');
    }

    if (ind.rsi < 35) buyState.push(`RSI oversold (${ind.rsi.toFixed(1)})`);
    else if (ind.rsi > 65) sellState.push(`RSI overbought (${ind.rsi.toFixed(1)})`);

    if (ind.rsiPrev) {
      if (ind.rsi > ind.rsiPrev && ind.rsi < 40) buyState.push('RSI rising from low');
      else if (ind.rsi < ind.rsiPrev && ind.rsi > 60) sellState.push('RSI falling from high');
    }

    if (!eventSources.has('stoch') && ind.stoch) {
      if (ind.stoch.k < 25 && ind.stoch.d < 25) buyState.push('Stochastic oversold');
      else if (ind.stoch.k > 75 && ind.stoch.d > 75) sellState.push('Stochastic overbought');
    }

    if (ind.bb) {
      const pB = (ind.price - ind.bb.lower) / (ind.bb.upper - ind.bb.lower);
      if (pB < 0.10) buyState.push('Price at lower Bollinger Band');
      else if (pB > 0.90) sellState.push('Price at upper Bollinger Band');
    }

    if (ind.adx && ind.adx.adx > 22) {
      if (ind.adx.pdi > ind.adx.mdi) buyState.push(`ADX bullish (${ind.adx.adx.toFixed(0)})`);
      else sellState.push(`ADX bearish (${ind.adx.adx.toFixed(0)})`);
    }

    // ═══════════════════════════════════════════════════════════
    // CONFLICT DETECTION v6
    // ═══════════════════════════════════════════════════════════

    // --- Carried from v5 ---

    if (ind.stoch) {
      if (ind.stoch.k < 25) conflicts.push({ blocks: 'SELL', reason: `Stoch oversold (${ind.stoch.k.toFixed(0)})` });
      if (ind.stoch.k > 75) conflicts.push({ blocks: 'BUY', reason: `Stoch overbought (${ind.stoch.k.toFixed(0)})` });
    }

    if (ind.rsi < 30) conflicts.push({ blocks: 'SELL', reason: `RSI oversold (${ind.rsi.toFixed(0)})` });
    if (ind.rsi > 70) conflicts.push({ blocks: 'BUY', reason: `RSI overbought (${ind.rsi.toFixed(0)})` });

    if (ind.macd && !eventSources.has('macd')) {
      if (ind.macd.histogram > 0) conflicts.push({ blocks: 'SELL', reason: `MACD histogram positive (+${ind.macd.histogram.toFixed(3)})` });
      if (ind.macd.histogram < 0) conflicts.push({ blocks: 'BUY', reason: `MACD histogram negative (${ind.macd.histogram.toFixed(3)})` });
    }

    const rsiNeutral = ind.rsi >= 40 && ind.rsi <= 60;
    const stochNeutral = ind.stoch && ind.stoch.k >= 35 && ind.stoch.k <= 65;
    if (rsiNeutral && stochNeutral) {
      conflicts.push({ blocks: 'BOTH', reason: `Neutral momentum (RSI:${ind.rsi.toFixed(0)} Stoch:${ind.stoch.k.toFixed(0)})` });
    }

    if (ind.bb) {
      const pB = (ind.price - ind.bb.lower) / (ind.bb.upper - ind.bb.lower);
      if (pB < 0.05) conflicts.push({ blocks: 'SELL', reason: 'Price at extreme lower BB' });
      if (pB > 0.95) conflicts.push({ blocks: 'BUY', reason: 'Price at extreme upper BB' });
    }

    // S/R proximity
    const atrValue = ind.atr || currentPrice * 0.01;
    const sr = ctx.sr;

    if (sr.resistance > 0) {
      const distToR = sr.resistance - currentPrice;
      if (distToR >= 0 && distToR < atrValue * 1.0) {
        conflicts.push({ blocks: 'BUY', reason: `Too close to resistance ${sr.resistance.toFixed(2)} (${distToR.toFixed(2)} away)` });
      }
    }

    if (sr.support > 0) {
      const distToS = currentPrice - sr.support;
      if (distToS >= 0 && distToS < atrValue * 1.0) {
        conflicts.push({ blocks: 'SELL', reason: `Too close to support ${sr.support.toFixed(2)} (${distToS.toFixed(2)} away)` });
      }
    }

    // Ranging block
    const adxValue = ind.adx?.adx || 0;
    if (ctx.regime === 'RANGING' && adxValue < 20) {
      const hasExtremeRSI = ind.rsi < 30 || ind.rsi > 70;
      const hasExtremeStoch = ind.stoch && (ind.stoch.k < 20 || ind.stoch.k > 80);
      if (!hasExtremeRSI && !hasExtremeStoch) {
        conflicts.push({ blocks: 'BOTH', reason: `Ranging market (ADX:${adxValue.toFixed(0)})` });
      }
    }

    // ═══════════════════════════════════════════════════════════
    // v6 NEW CONFLICTS — THE SUPERPOWERS
    // ═══════════════════════════════════════════════════════════

    // 1. MOMENTUM PERSISTENCE BLOCK
    //    Stoch stuck overbought for 4+ candles = momentum, not reversal
    //    Don't sell into persistent bullish momentum
    //    Don't buy into persistent bearish momentum
    if (momentum.stochPersistence === 'OVERBOUGHT_PERSISTENT') {
      conflicts.push({ blocks: 'SELL', reason: `Stoch overbought 4+ candles — momentum move, not reversal` });
    }
    if (momentum.stochPersistence === 'OVERSOLD_PERSISTENT') {
      conflicts.push({ blocks: 'BUY', reason: `Stoch oversold 4+ candles — momentum move, not reversal` });
    }

    // 2. PRICE STRUCTURE BLOCK
    //    Higher Highs + Higher Lows = bullish structure → don't sell
    //    Lower Highs + Lower Lows = bearish structure → don't buy
    if (momentum.priceStructure === 'BULLISH_STRUCTURE') {
      conflicts.push({ blocks: 'SELL', reason: `Bullish price structure (${momentum.higherHighs}HH/${momentum.higherLows}HL) — don't fight it` });
    }
    if (momentum.priceStructure === 'BEARISH_STRUCTURE') {
      conflicts.push({ blocks: 'BUY', reason: `Bearish price structure (${momentum.lowerHighs}LH/${momentum.lowerLows}LL) — don't fight it` });
    }

    // 3. CANDLE MOMENTUM BLOCK
    //    3+ consecutive bullish candles = buyers in control → don't sell
    //    3+ consecutive bearish candles = sellers in control → don't buy
    if (momentum.bullishCandles >= 3) {
      conflicts.push({ blocks: 'SELL', reason: `${momentum.bullishCandles} consecutive bullish candles — strong buying pressure` });
    }
    if (momentum.bearishCandles >= 3) {
      conflicts.push({ blocks: 'BUY', reason: `${momentum.bearishCandles} consecutive bearish candles — strong selling pressure` });
    }

    // 4. LARGE MOVE PROTECTION
    //    Price moved 3+ ATR in 8 candles = strong directional move
    //    Only allow signals WITH the move direction, not against it
    if (momentum.isMomentumMove) {
      const movingUp = ind.price > ind.recentCloses[ind.recentCloses.length - 9] || ind.price > ind.ema9;
      const movingDown = ind.price < ind.recentCloses[ind.recentCloses.length - 9] || ind.price < ind.ema9;
      if (movingUp) {
        conflicts.push({ blocks: 'SELL', reason: `Large momentum move UP (${momentum.moveSize.toFixed(1)}x ATR) — don't fade it` });
      }
      if (movingDown) {
        conflicts.push({ blocks: 'BUY', reason: `Large momentum move DOWN (${momentum.moveSize.toFixed(1)}x ATR) — don't fade it` });
      }
    }

    // ═══════════════════════════════════════════════════════════
    // DECISION LOGIC
    // ═══════════════════════════════════════════════════════════

    const totalBuyEvents = buyStrong.length + buyWeak.length;
    const totalSellEvents = sellStrong.length + sellWeak.length;
    const totalBuy = totalBuyEvents + buyState.length;
    const totalSell = totalSellEvents + sellState.length;

    const buyHasValidEvent = buyStrong.length >= 1 || buyWeak.length >= 2;
    const sellHasValidEvent = sellStrong.length >= 1 || sellWeak.length >= 2;

    const buyConflicts = conflicts.filter(c => c.blocks === 'BUY' || c.blocks === 'BOTH');
    const sellConflicts = conflicts.filter(c => c.blocks === 'SELL' || c.blocks === 'BOTH');

    let action = 'HOLD', confidence = 0, reasons = [], warnings = [];
    let confluenceCount = 0, eventCount = 0, stateCount = 0;

    if (buyHasValidEvent && totalBuy >= this.minConfluence && totalBuy > totalSell && buyConflicts.length === 0) {
      action = 'BUY';
      confluenceCount = totalBuy;
      eventCount = totalBuyEvents;
      stateCount = buyState.length;
      reasons = [...buyStrong, ...buyWeak, ...buyState];
      confidence = Math.min(25 + (confluenceCount * 8), 85);
      if (buyStrong.length >= 2) confidence = Math.min(confidence + 10, 90);
      else if (buyStrong.length >= 1) confidence = Math.min(confidence + 5, 88);

    } else if (sellHasValidEvent && totalSell >= this.minConfluence && totalSell > totalBuy && sellConflicts.length === 0) {
      action = 'SELL';
      confluenceCount = totalSell;
      eventCount = totalSellEvents;
      stateCount = sellState.length;
      reasons = [...sellStrong, ...sellWeak, ...sellState];
      confidence = Math.min(25 + (confluenceCount * 8), 85);
      if (sellStrong.length >= 2) confidence = Math.min(confidence + 10, 90);
      else if (sellStrong.length >= 1) confidence = Math.min(confidence + 5, 88);
    }

    // Report blocks
    if (action === 'HOLD') {
      if (totalBuyEvents > 0 && buyConflicts.length > 0)
        warnings = buyConflicts.map(c => `BLOCKED BUY: ${c.reason}`);
      else if (totalSellEvents > 0 && sellConflicts.length > 0)
        warnings = sellConflicts.map(c => `BLOCKED SELL: ${c.reason}`);
      else if (totalBuyEvents > 0 && !buyHasValidEvent)
        warnings.push('Weak event only (need 1 strong or 2+ weak)');
      else if (totalSellEvents > 0 && !sellHasValidEvent)
        warnings.push('Weak event only (need 1 strong or 2+ weak)');
    }

    // ── CONTEXT ADJUSTMENTS ──
    if (action !== 'HOLD') {

      // Hard block against strong trend
      if (action === 'BUY' && ctx.trend === 'BEARISH' && ctx.trendStrength > 30)
        return this.holdResult(symbol, currentPrice, ind, ctx, momentum, ['BLOCKED: Strong bearish trend (ADX:' + ctx.trendStrength.toFixed(0) + ')']);
      if (action === 'SELL' && ctx.trend === 'BULLISH' && ctx.trendStrength > 30)
        return this.holdResult(symbol, currentPrice, ind, ctx, momentum, ['BLOCKED: Strong bullish trend (ADX:' + ctx.trendStrength.toFixed(0) + ')']);

      // Against weak trend penalty
      if (action === 'BUY' && ctx.trend === 'BEARISH') {
        confidence = Math.round(confidence * 0.5);
        warnings.push('Against bearish trend (-50%)');
      }
      if (action === 'SELL' && ctx.trend === 'BULLISH') {
        confidence = Math.round(confidence * 0.5);
        warnings.push('Against bullish trend (-50%)');
      }

      // With-trend boost — only with ADX >= 20
      if (action === 'BUY' && ctx.trend === 'BULLISH' && ctx.trendStrength >= 20) {
        confidence = Math.min(Math.round(confidence * 1.15), 90);
        reasons.push(`With bullish trend (ADX:${ctx.trendStrength.toFixed(0)})`);
      }
      if (action === 'SELL' && ctx.trend === 'BEARISH' && ctx.trendStrength >= 20) {
        confidence = Math.min(Math.round(confidence * 1.15), 90);
        reasons.push(`With bearish trend (ADX:${ctx.trendStrength.toFixed(0)})`);
      }

      // v6: Price structure boost — trading WITH the structure
      if (action === 'BUY' && momentum.priceStructure === 'BULLISH_STRUCTURE') {
        confidence = Math.min(Math.round(confidence * 1.1), 90);
        reasons.push('Bullish price structure');
      }
      if (action === 'SELL' && momentum.priceStructure === 'BEARISH_STRUCTURE') {
        confidence = Math.min(Math.round(confidence * 1.1), 90);
        reasons.push('Bearish price structure');
      }

      // Session adjustments
      if (ctx.session === 'OVERLAP') {
        confidence = Math.min(Math.round(confidence * 1.1), 90);
        reasons.push('London/NY overlap');
      } else if (ctx.session === 'LONDON' || ctx.session === 'NEW_YORK') {
        confidence = Math.min(Math.round(confidence * 1.05), 90);
      } else if (ctx.session === 'ASIAN') {
        confidence = Math.round(confidence * 0.85);
        warnings.push('Asian session (-15%)');
      }

      if (ctx.volatility === 'HIGH') {
        confidence = Math.round(confidence * 0.9);
        warnings.push('High volatility');
      }

      // Confidence floor
      if (confidence < 40)
        return this.holdResult(symbol, currentPrice, ind, ctx, momentum, ['Confidence too low after adjustments']);
    }

    // ── CALCULATE SL/TP AND CHECK R:R ──
    const slMul = ctx.volatility === 'HIGH' ? 2.5 : 2.0;
    let stopLoss = 0, takeProfit = 0, riskReward = 0;

    if (action !== 'HOLD') {
      if (action === 'BUY') {
        stopLoss = currentPrice - (atrValue * slMul);
        const atrTP = currentPrice + (atrValue * slMul * this.minRR);
        const resistanceTP = sr.resistance > currentPrice ? sr.resistance : atrTP;
        takeProfit = Math.max(atrTP, resistanceTP);
      } else {
        stopLoss = currentPrice + (atrValue * slMul);
        const atrTP = currentPrice - (atrValue * slMul * this.minRR);
        const supportTP = sr.support < currentPrice ? sr.support : atrTP;
        takeProfit = Math.min(atrTP, supportTP);
      }

      const risk = Math.abs(currentPrice - stopLoss);
      const reward = Math.abs(takeProfit - currentPrice);
      riskReward = risk > 0 ? parseFloat((reward / risk).toFixed(2)) : 0;

      if (riskReward < this.minRR)
        return this.holdResult(symbol, currentPrice, ind, ctx, momentum, [`R:R too low (${riskReward} < ${this.minRR})`]);
    }

    return {
      symbol, action, confidence, price: currentPrice, stopLoss, takeProfit, riskReward,
      reasons, warnings,
      context: { trend: ctx.trend, trendStrength: ctx.trendStrength, regime: ctx.regime, session: ctx.session, volatility: ctx.volatility, support: ctx.sr.support, resistance: ctx.sr.resistance },
      momentum: {
        bullishCandles: momentum.bullishCandles, bearishCandles: momentum.bearishCandles,
        priceStructure: momentum.priceStructure, stochPersistence: momentum.stochPersistence,
        moveSize: momentum.moveSize.toFixed(1), isMomentumMove: momentum.isMomentumMove
      },
      confluenceCount, eventCount, stateCount,
      indicators: {
        rsi: ind.rsi?.toFixed(2), macd: ind.macd?.histogram?.toFixed(5), adx: ind.adx?.adx?.toFixed(2),
        atr: atrValue?.toFixed(5), stochK: ind.stoch?.k?.toFixed(2), stochD: ind.stoch?.d?.toFixed(2),
        cci: ind.cci?.toFixed(2), ema9: ind.ema9?.toFixed(5), ema21: ind.ema21?.toFixed(5), ema50: ind.ema50?.toFixed(5)
      },
      timestamp: Date.now()
    };
  }

  holdResult(symbol, currentPrice, ind, ctx, momentum, warnings) {
    const atrValue = ind.atr || currentPrice * 0.01;
    return {
      symbol, action: 'HOLD', confidence: 0, price: currentPrice, stopLoss: 0, takeProfit: 0, riskReward: 0,
      reasons: [], warnings,
      context: { trend: ctx.trend, trendStrength: ctx.trendStrength, regime: ctx.regime, session: ctx.session, volatility: ctx.volatility, support: ctx.sr.support, resistance: ctx.sr.resistance },
      momentum: {
        bullishCandles: momentum.bullishCandles, bearishCandles: momentum.bearishCandles,
        priceStructure: momentum.priceStructure, stochPersistence: momentum.stochPersistence,
        moveSize: momentum.moveSize.toFixed(1), isMomentumMove: momentum.isMomentumMove
      },
      confluenceCount: 0, eventCount: 0, stateCount: 0,
      indicators: {
        rsi: ind.rsi?.toFixed(2), macd: ind.macd?.histogram?.toFixed(5), adx: ind.adx?.adx?.toFixed(2),
        atr: atrValue?.toFixed(5), stochK: ind.stoch?.k?.toFixed(2), stochD: ind.stoch?.d?.toFixed(2),
        cci: ind.cci?.toFixed(2), ema9: ind.ema9?.toFixed(5), ema21: ind.ema21?.toFixed(5), ema50: ind.ema50?.toFixed(5)
      },
      timestamp: Date.now()
    };
  }
}