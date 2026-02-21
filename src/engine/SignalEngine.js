import { RSI, MACD, EMA, SMA, BollingerBands, ATR, Stochastic, ADX, CCI } from 'technicalindicators';
import { SRDetector } from './SRDetector.js';

export class SignalEngine {
  constructor(config = {}) {
    this.candleStore = new Map();
    this.minConfluence = config.minConfluence || 3;
    this.minRR = config.minRR || 1.5;
    this.srDetector = new SRDetector(); // v2 S/R detection
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
    if (!candles || candles.length < 110) return null; // Need 110 for EMA100

    // Set current candle time for session detection (backtest uses historical time)
    if (!this.currentCandleTime) {
      this.currentCandleTime = candles[candles.length - 1].timestamp;
    }

    const closes = candles.map(c => c.close);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const opens = candles.map(c => c.open);
    const ind = this.calcIndicators(closes, highs, lows, opens);
    if (!ind) return null;
    const ctx = this.getContext(ind, closes, highs, lows);
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
      const ema100 = EMA.calculate({ values: closes, period: 100 }); // Macro trend filter
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
        rsiHistory: rsi.slice(-6),
        macd: macd[macd.length - 1], macdPrev: macd[macd.length - 2],
        macdPrev2: macd.length > 2 ? macd[macd.length - 3] : null,
        ema9: ema9[ema9.length - 1], ema21: ema21[ema21.length - 1], ema50: ema50[ema50.length - 1],
        ema100: ema100.length > 0 ? ema100[ema100.length - 1] : null,
        sma200: sma200.length > 0 ? sma200[sma200.length - 1] : null,
        ema9Prev: ema9[ema9.length - 2], ema21Prev: ema21[ema21.length - 2],
        bb: bb[bb.length - 1],
        atr: atr[atr.length - 1], atr7: atr7.length > 0 ? atr7[atr7.length - 1] : atr[atr.length - 1],
        atrPrev: atr.length > 5 ? atr[atr.length - 5] : atr[atr.length - 1],
        atrHistory: atr.slice(-10), // For volatility expansion check
        stoch: stoch[stoch.length - 1], stochPrev: stoch.length > 1 ? stoch[stoch.length - 2] : null,
        stochHistory: stoch.slice(-6),
        adx: adx[adx.length - 1],
        cci: cci[cci.length - 1], cciPrev: cci.length > 1 ? cci[cci.length - 2] : null,
        recentHighs: highs.slice(-30), recentLows: lows.slice(-30), recentCloses: closes.slice(-30),
        // Pass full arrays for SRDetector v2
        allHighs: highs, allLows: lows, allCloses: closes
      };
    } catch (err) { console.error('Indicator error:', err.message); return null; }
  }

  // ═══════════════════════════════════════════════════════════════
  // v6 MOMENTUM ANALYZER (unchanged)
  // ═══════════════════════════════════════════════════════════════
  analyzeMomentum(candles, ind) {
    const recent = candles.slice(-8);
    const momentum = {
      bullishCandles: 0, bearishCandles: 0,
      higherHighs: 0, higherLows: 0, lowerHighs: 0, lowerLows: 0,
      priceStructure: 'NONE',
      stochPersistence: 'NONE', rsiPersistence: 'NONE',
      moveSize: 0, isMomentumMove: false
    };

    for (let i = recent.length - 1; i >= 0; i--) {
      if (recent[i].close > recent[i].open) {
        if (momentum.bearishCandles > 0) break;
        momentum.bullishCandles++;
      } else {
        if (momentum.bullishCandles > 0) break;
        momentum.bearishCandles++;
      }
    }

    for (let i = 2; i < recent.length; i++) {
      if (recent[i].high > recent[i-1].high) momentum.higherHighs++;
      else if (recent[i].high < recent[i-1].high) momentum.lowerHighs++;
      if (recent[i].low > recent[i-1].low) momentum.higherLows++;
      else if (recent[i].low < recent[i-1].low) momentum.lowerLows++;
    }

    if (momentum.higherHighs >= 3 && momentum.higherLows >= 3) momentum.priceStructure = 'BULLISH_STRUCTURE';
    else if (momentum.lowerHighs >= 3 && momentum.lowerLows >= 3) momentum.priceStructure = 'BEARISH_STRUCTURE';

    if (recent.length >= 2 && ind.atr) {
      const moveSize = Math.abs(recent[recent.length - 1].close - recent[0].open);
      const atrMultiple = moveSize / ind.atr;
      momentum.moveSize = atrMultiple;
      if (atrMultiple > 3) momentum.isMomentumMove = true;
    }

    if (ind.stochHistory && ind.stochHistory.length >= 4) {
      const lastFour = ind.stochHistory.slice(-4);
      if (lastFour.every(s => s.k > 75)) momentum.stochPersistence = 'OVERBOUGHT_PERSISTENT';
      if (lastFour.every(s => s.k < 25)) momentum.stochPersistence = 'OVERSOLD_PERSISTENT';
    }

    if (ind.rsiHistory && ind.rsiHistory.length >= 4) {
      const lastFour = ind.rsiHistory.slice(-4);
      if (lastFour.every(r => r > 60)) momentum.rsiPersistence = 'HIGH_PERSISTENT';
      if (lastFour.every(r => r < 40)) momentum.rsiPersistence = 'LOW_PERSISTENT';
    }

    return momentum;
  }

  getContext(ind, closes, highs, lows) {
    const ctx = {
      trend: 'NEUTRAL', trendStrength: 0, volatility: 'NORMAL',
      session: 'OFF_HOURS', regime: 'RANGING',
      sr: { support: 0, resistance: 0, supports: [], resistances: [], nearestSupport: null, nearestResistance: null }
    };

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

    if (ind.atr7 && ind.atrPrev) {
      const r = ind.atr7 / ind.atrPrev;
      if (r > 1.5) ctx.volatility = 'HIGH';
      else if (r < 0.7) ctx.volatility = 'LOW';
    }
    if (ind.bb) { const w = (ind.bb.upper - ind.bb.lower) / ind.bb.middle; if (w < 0.005) ctx.volatility = 'SQUEEZE'; }

    // Use candle timestamp in backtest mode, current time in live mode
    const h = new Date(this.currentCandleTime || Date.now()).getUTCHours();
    if (h >= 12 && h < 16) ctx.session = 'OVERLAP';
    else if (h >= 7 && h < 16) ctx.session = 'LONDON';
    else if (h >= 12 && h < 21) ctx.session = 'NEW_YORK';
    else if (h >= 23 || h < 8) ctx.session = 'ASIAN';

    if (adxValue >= 25) ctx.regime = 'TRENDING';
    const rH = Math.max(...highs.slice(-20, -1));
    const rL = Math.min(...lows.slice(-20, -1));
    if ((ind.price > rH || ind.price < rL) && adxValue >= 20) ctx.regime = 'BREAKOUT';

    // ── v2 S/R DETECTION ──
    ctx.sr = this.srDetector.findSR(closes, highs, lows, ind.atr);

    return ctx;
  }

  // ── LEGACY findSR kept for fallback ──
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

  generateSignal(symbol, ind, ctx, momentum, currentPrice) {
    const buyStrong = [], sellStrong = [];
    const buyWeak = [], sellWeak = [];
    const buyState = [], sellState = [];
    const conflicts = [];
    const eventSources = new Set();

    // ─── STRONG EVENTS ───

    if (ind.ema9 > ind.ema21 && ind.ema9Prev <= ind.ema21Prev) {
      buyStrong.push('EMA 9/21 bullish crossover'); eventSources.add('ema');
    } else if (ind.ema9 < ind.ema21 && ind.ema9Prev >= ind.ema21Prev) {
      sellStrong.push('EMA 9/21 bearish crossover'); eventSources.add('ema');
    }

    if (ind.macd && ind.macdPrev) {
      if (ind.macd.MACD > ind.macd.signal && ind.macdPrev.MACD <= ind.macdPrev.signal) {
        buyStrong.push('MACD bullish crossover'); eventSources.add('macd');
      } else if (ind.macd.MACD < ind.macd.signal && ind.macdPrev.MACD >= ind.macdPrev.signal) {
        sellStrong.push('MACD bearish crossover'); eventSources.add('macd');
      }
    }

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

    // ─── STATE SIGNALS ───

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
    // CONFLICT DETECTION v6 + UPGRADED S/R
    // ═══════════════════════════════════════════════════════════

    if (ind.stoch) {
      if (ind.stoch.k < 25) conflicts.push({ blocks: 'SELL', reason: `Stoch oversold (${ind.stoch.k.toFixed(0)})` });
      if (ind.stoch.k > 75) conflicts.push({ blocks: 'BUY', reason: `Stoch overbought (${ind.stoch.k.toFixed(0)})` });
    }

    if (ind.rsi < 30) conflicts.push({ blocks: 'SELL', reason: `RSI oversold (${ind.rsi.toFixed(0)})` });
    if (ind.rsi > 70) conflicts.push({ blocks: 'BUY', reason: `RSI overbought (${ind.rsi.toFixed(0)})` });

    // MACD histogram conflict — only block if histogram is meaningful (>0.5 ATR% of price)
    // Prevents blocking on tiny 0.001 histogram values
    if (ind.macd && !eventSources.has('macd')) {
      const histThreshold = currentPrice * 0.0001; // 0.01% of price = meaningful
      if (ind.macd.histogram > histThreshold) conflicts.push({ blocks: 'SELL', reason: `MACD histogram positive (+${ind.macd.histogram.toFixed(3)})` });
      if (ind.macd.histogram < -histThreshold) conflicts.push({ blocks: 'BUY', reason: `MACD histogram negative (${ind.macd.histogram.toFixed(3)})` });
    }

    // Neutral momentum block — tightened zones to reduce over-blocking
    // Old: RSI 40-60 + Stoch 35-65 (too wide)
    // New: RSI 43-57 + Stoch 40-60 (truly neutral only)
    const rsiNeutral = ind.rsi >= 43 && ind.rsi <= 57;
    const stochNeutral = ind.stoch && ind.stoch.k >= 40 && ind.stoch.k <= 60;
    if (rsiNeutral && stochNeutral) {
      conflicts.push({ blocks: 'BOTH', reason: `Neutral momentum (RSI:${ind.rsi.toFixed(0)} Stoch:${ind.stoch.k.toFixed(0)})` });
    }

    if (ind.bb) {
      const pB = (ind.price - ind.bb.lower) / (ind.bb.upper - ind.bb.lower);
      if (pB < 0.05) conflicts.push({ blocks: 'SELL', reason: 'Price at extreme lower BB' });
      if (pB > 0.95) conflicts.push({ blocks: 'BUY', reason: 'Price at extreme upper BB' });
    }

    // ── S/R PROXIMITY: SOFT PENALTY instead of hard block ──
    // Hard blocking was killing too many signals (814 blocks in 5000 candles)
    // Now: close to strong level = confidence penalty, not full block
    // Only HARD block if price is literally sitting on the level (< 0.2 ATR)
    const atrValue = ind.atr || currentPrice * 0.01;
    const sr = ctx.sr;
    let srPenalty = { buy: 0, sell: 0, buyReason: '', sellReason: '' };

    if (sr.nearestResistance) {
      const distToR = sr.nearestResistance.price - currentPrice;
      if (distToR >= 0) {
        if (distToR < atrValue * 0.2 && sr.nearestResistance.strength >= 60) {
          // Literally at resistance — hard block
          conflicts.push({ blocks: 'BUY', reason: `AT resistance ${sr.nearestResistance.price.toFixed(2)} (str:${sr.nearestResistance.strength.toFixed(0)})` });
        } else if (distToR < atrValue * 1.0 && sr.nearestResistance.strength >= 50) {
          // Near resistance — soft penalty stored for later
          srPenalty.buy = 0.85;
          srPenalty.buyReason = `Near resistance ${sr.nearestResistance.price.toFixed(2)} (-15%)`;
        }
      }
    }

    if (sr.nearestSupport) {
      const distToS = currentPrice - sr.nearestSupport.price;
      if (distToS >= 0) {
        if (distToS < atrValue * 0.2 && sr.nearestSupport.strength >= 60) {
          // Literally at support — hard block
          conflicts.push({ blocks: 'SELL', reason: `AT support ${sr.nearestSupport.price.toFixed(2)} (str:${sr.nearestSupport.strength.toFixed(0)})` });
        } else if (distToS < atrValue * 1.0 && sr.nearestSupport.strength >= 50) {
          srPenalty.sell = 0.85;
          srPenalty.sellReason = `Near support ${sr.nearestSupport.price.toFixed(2)} (-15%)`;
        }
      }
    }

    // Ranging block — raised ADX threshold from 20 to 22
    // ADX 20-22 is borderline trending, not reliable enough to trade
    const adxValue = ind.adx?.adx || 0;
    if (adxValue < 22) {
      const hasExtremeRSI = ind.rsi < 30 || ind.rsi > 70;
      const hasExtremeStoch = ind.stoch && (ind.stoch.k < 20 || ind.stoch.k > 80);
      if (!hasExtremeRSI && !hasExtremeStoch) {
        conflicts.push({ blocks: 'BOTH', reason: `Ranging market (ADX:${adxValue.toFixed(0)})` });
      }
    }

    // NEW: Weak trend block — if trend exists but ADX < 25, require price to be
    // clearly on the right side of EMA50 (not just barely above/below it)
    if (adxValue >= 22 && adxValue < 25) {
      const distFromEma50 = Math.abs(ind.price - ind.ema50);
      const atrPct = distFromEma50 / atrValue;
      if (atrPct < 0.5) {
        // Price is within 0.5 ATR of EMA50 — too close to trend line, choppy area
        conflicts.push({ blocks: 'BOTH', reason: `Price too close to EMA50 in weak trend (ADX:${adxValue.toFixed(0)})` });
      }
    }

    // v6 Momentum conflicts
    if (momentum.stochPersistence === 'OVERBOUGHT_PERSISTENT')
      conflicts.push({ blocks: 'SELL', reason: `Stoch overbought 4+ candles — momentum move` });
    if (momentum.stochPersistence === 'OVERSOLD_PERSISTENT')
      conflicts.push({ blocks: 'BUY', reason: `Stoch oversold 4+ candles — momentum move` });

    // Price structure — raised to 4+ HH/HL to avoid over-blocking on normal retracements
    if (momentum.higherHighs >= 4 && momentum.higherLows >= 4) {
      conflicts.push({ blocks: 'SELL', reason: `Bullish structure (${momentum.higherHighs}HH/${momentum.higherLows}HL)` });
    }
    if (momentum.lowerHighs >= 4 && momentum.lowerLows >= 4) {
      conflicts.push({ blocks: 'BUY', reason: `Bearish structure (${momentum.lowerHighs}LH/${momentum.lowerLows}LL)` });
    }

    if (momentum.bullishCandles >= 3)
      conflicts.push({ blocks: 'SELL', reason: `${momentum.bullishCandles} consecutive bullish candles` });
    if (momentum.bearishCandles >= 3)
      conflicts.push({ blocks: 'BUY', reason: `${momentum.bearishCandles} consecutive bearish candles` });

    if (momentum.isMomentumMove) {
      const movingUp = ind.price > ind.ema9;
      const movingDown = ind.price < ind.ema9;
      if (movingUp) conflicts.push({ blocks: 'SELL', reason: `Large move UP (${momentum.moveSize.toFixed(1)}x ATR)` });
      if (movingDown) conflicts.push({ blocks: 'BUY', reason: `Large move DOWN (${momentum.moveSize.toFixed(1)}x ATR)` });
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
      confluenceCount = totalBuy; eventCount = totalBuyEvents; stateCount = buyState.length;
      reasons = [...buyStrong, ...buyWeak, ...buyState];
      confidence = Math.min(25 + (confluenceCount * 8), 85);
      if (buyStrong.length >= 2) confidence = Math.min(confidence + 10, 90);
      else if (buyStrong.length >= 1) confidence = Math.min(confidence + 5, 88);

    } else if (sellHasValidEvent && totalSell >= this.minConfluence && totalSell > totalBuy && sellConflicts.length === 0) {
      action = 'SELL';
      confluenceCount = totalSell; eventCount = totalSellEvents; stateCount = sellState.length;
      reasons = [...sellStrong, ...sellWeak, ...sellState];
      confidence = Math.min(25 + (confluenceCount * 8), 85);
      if (sellStrong.length >= 2) confidence = Math.min(confidence + 10, 90);
      else if (sellStrong.length >= 1) confidence = Math.min(confidence + 5, 88);
    }

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

    // ═══════════════════════════════════════════════════════════
    // MACRO TREND FILTER (replaces broken entry candle filter)
    //
    // Root cause of all losses: 5min ADX doesn't see macro trend.
    // Gold was in a massive bull run all February. SELL signals lost
    // because they were fighting a $100 macro move.
    //
    // Fix 1: EMA100 macro trend bias
    //   - Price above EMA100 = macro bullish → SELL gets heavy penalty
    //   - Price below EMA100 = macro bearish → BUY gets heavy penalty
    //   - Strong macro (price > 1 ATR from EMA100) = hard block counter-direction
    //
    // Fix 2: Volatility expansion requirement
    //   - Only trade when ATR is expanding (market is moving)
    //   - ATR contracting = consolidation = don't enter
    // ═══════════════════════════════════════════════════════════
    if (action !== 'HOLD') {

      // ── NOTE: Macro filter removed — caused more harm than good on 9-signal sample
      // Will tune after collecting 50+ live signals with real outcomes
    }

    // ── CONTEXT ADJUSTMENTS ──
    if (action !== 'HOLD') {
      if (action === 'BUY' && ctx.trend === 'BEARISH' && ctx.trendStrength > 30)
        return this.holdResult(symbol, currentPrice, ind, ctx, momentum, ['BLOCKED: Strong bearish trend (ADX:' + ctx.trendStrength.toFixed(0) + ')']);
      if (action === 'SELL' && ctx.trend === 'BULLISH' && ctx.trendStrength > 30)
        return this.holdResult(symbol, currentPrice, ind, ctx, momentum, ['BLOCKED: Strong bullish trend (ADX:' + ctx.trendStrength.toFixed(0) + ')']);

      if (action === 'BUY' && ctx.trend === 'BEARISH') { confidence = Math.round(confidence * 0.5); warnings.push('Against bearish trend (-50%)'); }
      if (action === 'SELL' && ctx.trend === 'BULLISH') { confidence = Math.round(confidence * 0.5); warnings.push('Against bullish trend (-50%)'); }

      if (action === 'BUY' && ctx.trend === 'BULLISH' && ctx.trendStrength >= 20) {
        confidence = Math.min(Math.round(confidence * 1.15), 90);
        reasons.push(`With bullish trend (ADX:${ctx.trendStrength.toFixed(0)})`);
      }
      if (action === 'SELL' && ctx.trend === 'BEARISH' && ctx.trendStrength >= 20) {
        confidence = Math.min(Math.round(confidence * 1.15), 90);
        reasons.push(`With bearish trend (ADX:${ctx.trendStrength.toFixed(0)})`);
      }

      // v6: Structure boost
      if (action === 'BUY' && momentum.priceStructure === 'BULLISH_STRUCTURE') {
        confidence = Math.min(Math.round(confidence * 1.1), 90);
        reasons.push('Bullish price structure');
      }
      if (action === 'SELL' && momentum.priceStructure === 'BEARISH_STRUCTURE') {
        confidence = Math.min(Math.round(confidence * 1.1), 90);
        reasons.push('Bearish price structure');
      }

      // NEW: S/R proximity soft penalty
      if (action === 'BUY' && srPenalty.buy > 0) {
        confidence = Math.round(confidence * srPenalty.buy);
        warnings.push(srPenalty.buyReason);
      }
      if (action === 'SELL' && srPenalty.sell > 0) {
        confidence = Math.round(confidence * srPenalty.sell);
        warnings.push(srPenalty.sellReason);
      }

      // NEW: S/R strength boost — signal with strong level behind it
      if (action === 'BUY' && sr.nearestSupport && sr.nearestSupport.strength >= 50) {
        const distToS = currentPrice - sr.nearestSupport.price;
        if (distToS < atrValue * 3) {
          confidence = Math.min(Math.round(confidence * 1.08), 90);
          reasons.push(`Strong support nearby (str:${sr.nearestSupport.strength.toFixed(0)})`);
        }
      }
      if (action === 'SELL' && sr.nearestResistance && sr.nearestResistance.strength >= 50) {
        const distToR = sr.nearestResistance.price - currentPrice;
        if (distToR < atrValue * 3) {
          confidence = Math.min(Math.round(confidence * 1.08), 90);
          reasons.push(`Strong resistance nearby (str:${sr.nearestResistance.strength.toFixed(0)})`);
        }
      }

      // Session adjustments
      if (ctx.session === 'OVERLAP') { confidence = Math.min(Math.round(confidence * 1.1), 90); reasons.push('London/NY overlap'); }
      else if (ctx.session === 'LONDON' || ctx.session === 'NEW_YORK') confidence = Math.min(Math.round(confidence * 1.05), 90);
      else if (ctx.session === 'ASIAN') { confidence = Math.round(confidence * 0.85); warnings.push('Asian session (-15%)'); }

      if (ctx.volatility === 'HIGH') { confidence = Math.round(confidence * 0.9); warnings.push('High volatility'); }

      if (confidence < 40)
        return this.holdResult(symbol, currentPrice, ind, ctx, momentum, ['Confidence too low after adjustments']);
    }

    // ── SL/TP CALCULATION ──
    // Pure ATR-based SL — no S/R tightening (caused artificially high R:R)
    // R:R capped between minRR (1.5) and 2.5 for realistic 5min scalping
    if (action !== 'HOLD') {
      // SL: 2.5x ATR standard, 3x ATR high volatility
      // XAU/USD 5min moves easily 2x ATR on spikes — need wider SL
      const slMul = ctx.volatility === 'HIGH' ? 3.0 : 2.5;
      const maxRR = 2.5;
      let stopLoss = 0, takeProfit = 0, riskReward = 0;

      if (action === 'BUY') {
        stopLoss = currentPrice - (atrValue * slMul);
        const risk = currentPrice - stopLoss;
        const fullTP = currentPrice + (risk * maxRR); // Always achieves maxRR
        // Only use resistance as TP if it's between minRR and maxRR (valid window)
        const minTPRequired = currentPrice + (risk * this.minRR);
        const resistanceTP = (sr.resistance > minTPRequired && sr.resistance < fullTP)
          ? sr.resistance : fullTP;
        takeProfit = resistanceTP;
      } else {
        stopLoss = currentPrice + (atrValue * slMul);
        const risk = stopLoss - currentPrice;
        const fullTP = currentPrice - (risk * maxRR);
        const minTPRequired = currentPrice - (risk * this.minRR);
        const supportTP = (sr.support < minTPRequired && sr.support > fullTP)
          ? sr.support : fullTP;
        takeProfit = supportTP;
      }

      const risk = Math.abs(currentPrice - stopLoss);
      const reward = Math.abs(takeProfit - currentPrice);
      riskReward = risk > 0 ? parseFloat((reward / risk).toFixed(2)) : 0;

      if (riskReward < this.minRR)
        return this.holdResult(symbol, currentPrice, ind, ctx, momentum, [`R:R too low (${riskReward} < ${this.minRR})`]);

      // Format S/R levels for Discord
      const srFormatted = this.srDetector.formatLevels(sr);

      return {
        symbol, action, confidence, price: currentPrice, stopLoss, takeProfit, riskReward,
        reasons, warnings,
        context: {
          trend: ctx.trend, trendStrength: ctx.trendStrength, regime: ctx.regime,
          session: ctx.session, volatility: ctx.volatility,
          support: ctx.sr.support, resistance: ctx.sr.resistance,
          // v2: Enhanced S/R info
          supportLevels: srFormatted.supports,
          resistanceLevels: srFormatted.resistances
        },
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

    return this.holdResult(symbol, currentPrice, ind, ctx, momentum, warnings);
  }

  holdResult(symbol, currentPrice, ind, ctx, momentum, warnings) {
    const atrValue = ind.atr || currentPrice * 0.01;
    return {
      symbol, action: 'HOLD', confidence: 0, price: currentPrice, stopLoss: 0, takeProfit: 0, riskReward: 0,
      reasons: [], warnings,
      context: {
        trend: ctx.trend, trendStrength: ctx.trendStrength, regime: ctx.regime,
        session: ctx.session, volatility: ctx.volatility,
        support: ctx.sr?.support || 0, resistance: ctx.sr?.resistance || 0
      },
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