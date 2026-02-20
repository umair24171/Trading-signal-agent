import { RSI, MACD, EMA, SMA, BollingerBands, ATR, Stochastic, ADX, CCI } from 'technicalindicators';

export class SignalEngine {
  constructor(config = {}) {
    this.candleStore = new Map();
    this.minConfluence = config.minConfluence || 3;
    this.minRR = config.minRR || 1.5; // NEW: Minimum risk:reward ratio
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
    const ind = this.calcIndicators(closes, highs, lows);
    if (!ind) return null;
    const ctx = this.getContext(ind, closes, highs, lows);
    return this.generateSignal(symbol, ind, ctx, closes[closes.length - 1]);
  }

  calcIndicators(closes, highs, lows) {
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
        macd: macd[macd.length - 1], macdPrev: macd[macd.length - 2],
        macdPrev2: macd.length > 2 ? macd[macd.length - 3] : null,
        ema9: ema9[ema9.length - 1], ema21: ema21[ema21.length - 1], ema50: ema50[ema50.length - 1],
        sma200: sma200.length > 0 ? sma200[sma200.length - 1] : null,
        ema9Prev: ema9[ema9.length - 2], ema21Prev: ema21[ema21.length - 2],
        bb: bb[bb.length - 1],
        atr: atr[atr.length - 1], atr7: atr7.length > 0 ? atr7[atr7.length - 1] : atr[atr.length - 1],
        atrPrev: atr.length > 5 ? atr[atr.length - 5] : atr[atr.length - 1],
        stoch: stoch[stoch.length - 1], stochPrev: stoch.length > 1 ? stoch[stoch.length - 2] : null,
        adx: adx[adx.length - 1],
        cci: cci[cci.length - 1], cciPrev: cci.length > 1 ? cci[cci.length - 2] : null,
        recentHighs: highs.slice(-30), recentLows: lows.slice(-30), recentCloses: closes.slice(-30)
      };
    } catch (err) { console.error('Indicator error:', err.message); return null; }
  }

  getContext(ind, closes, highs, lows) {
    const ctx = { trend: 'NEUTRAL', trendStrength: 0, volatility: 'NORMAL', session: 'OFF_HOURS', regime: 'RANGING', sr: { support: 0, resistance: 0 } };

    // ── TREND (now requires ADX >= 20 to even call it a trend) ──
    let ts = 0;
    if (ind.price > ind.ema50) ts++;
    if (ind.sma200 && ind.price > ind.sma200) ts++;
    if (ind.ema9 > ind.ema21) ts++;
    if (ind.ema21 > ind.ema50) ts++;

    const adxValue = ind.adx?.adx || 0;

    // KEY FIX: ADX must be >= 20 to confirm any trend
    // Below 20 = NEUTRAL regardless of EMA alignment
    if (adxValue >= 20) {
      if (ts >= 3) { ctx.trend = 'BULLISH'; ctx.trendStrength = adxValue; }
      else if (ts <= 1) { ctx.trend = 'BEARISH'; ctx.trendStrength = adxValue; }
    }
    // ADX < 20 = no trend, stays NEUTRAL

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

    // Regime — needs ADX >= 25 for TRENDING
    if (adxValue >= 25) ctx.regime = 'TRENDING';
    const rH = Math.max(...highs.slice(-20, -1));
    const rL = Math.min(...lows.slice(-20, -1));
    if ((ind.price > rH || ind.price < rL) && adxValue >= 20) ctx.regime = 'BREAKOUT';

    // S/R — improved with clustering
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
  // SIGNAL ENGINE v5
  //
  // NEW FILTERS from v4:
  //
  // 1. S/R PROXIMITY BLOCK
  //    Don't BUY within 1 ATR of resistance
  //    Don't SELL within 1 ATR of support
  //    (That signal bought at 5034 with resistance at 5034 — insane)
  //
  // 2. ADX MINIMUM 20 FOR TREND
  //    ADX < 20 = no trend = NEUTRAL context
  //    "With bullish trend" boost only when ADX >= 20
  //    (That signal claimed bullish trend with ADX 17)
  //
  // 3. MINIMUM R:R 1.5
  //    Reject any signal where R:R < 1.5
  //    (That signal had 1:1 R:R — not worth the risk)
  //
  // 4. RANGING MARKET BLOCK
  //    If regime is RANGING and ADX < 20, don't send trend signals
  //    Only mean-reversion at extremes would qualify
  //
  // KEPT from v4:
  //  - Strong vs weak events
  //  - MACD direction conflict
  //  - Neutral momentum block
  //  - No double counting
  //  - Against-trend blocking
  // ═══════════════════════════════════════════════════════════════
  generateSignal(symbol, ind, ctx, currentPrice) {
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
        buyStrong.push('Stochastic bullish crossover (oversold)'); eventSources.add('stoch');
      } else if (ind.stoch.k > 80 && ind.stoch.k < ind.stoch.d && ind.stochPrev.k >= ind.stochPrev.d) {
        sellStrong.push('Stochastic bearish crossover (overbought)'); eventSources.add('stoch');
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
    // CONFLICT DETECTION (from v4 + new v5 additions)
    // ═══════════════════════════════════════════════════════════

    // Stochastic conflicts
    if (ind.stoch) {
      if (ind.stoch.k < 25) conflicts.push({ blocks: 'SELL', reason: `Stoch oversold (${ind.stoch.k.toFixed(0)})` });
      if (ind.stoch.k > 75) conflicts.push({ blocks: 'BUY', reason: `Stoch overbought (${ind.stoch.k.toFixed(0)})` });
    }

    // RSI conflicts
    if (ind.rsi < 30) conflicts.push({ blocks: 'SELL', reason: `RSI oversold (${ind.rsi.toFixed(0)})` });
    if (ind.rsi > 70) conflicts.push({ blocks: 'BUY', reason: `RSI overbought (${ind.rsi.toFixed(0)})` });

    // MACD direction conflict
    if (ind.macd && !eventSources.has('macd')) {
      if (ind.macd.histogram > 0) conflicts.push({ blocks: 'SELL', reason: `MACD histogram positive (+${ind.macd.histogram.toFixed(3)})` });
      if (ind.macd.histogram < 0) conflicts.push({ blocks: 'BUY', reason: `MACD histogram negative (${ind.macd.histogram.toFixed(3)})` });
    }

    // Neutral momentum block (RSI 40-60 AND Stoch 35-65)
    const rsiNeutral = ind.rsi >= 40 && ind.rsi <= 60;
    const stochNeutral = ind.stoch && ind.stoch.k >= 35 && ind.stoch.k <= 65;
    if (rsiNeutral && stochNeutral) {
      conflicts.push({ blocks: 'BOTH', reason: `Neutral momentum (RSI:${ind.rsi.toFixed(0)} Stoch:${ind.stoch.k.toFixed(0)})` });
    }

    // Bollinger extreme conflicts
    if (ind.bb) {
      const pB = (ind.price - ind.bb.lower) / (ind.bb.upper - ind.bb.lower);
      if (pB < 0.05) conflicts.push({ blocks: 'SELL', reason: 'Price at extreme lower BB' });
      if (pB > 0.95) conflicts.push({ blocks: 'BUY', reason: 'Price at extreme upper BB' });
    }

    // ═══════════════════════════════════════════════════════════
    // NEW v5: S/R PROXIMITY CONFLICT
    // Don't BUY within 1 ATR of resistance (buying at ceiling)
    // Don't SELL within 1 ATR of support (selling at floor)
    // ═══════════════════════════════════════════════════════════
    const atrValue = ind.atr || currentPrice * 0.01;
    const sr = ctx.sr;

    if (sr.resistance > 0) {
      const distToResistance = sr.resistance - currentPrice;
      if (distToResistance >= 0 && distToResistance < atrValue * 1.0) {
        conflicts.push({ blocks: 'BUY', reason: `Too close to resistance ${sr.resistance.toFixed(2)} (${distToResistance.toFixed(2)} away, need ${(atrValue * 1.0).toFixed(2)})` });
      }
    }

    if (sr.support > 0) {
      const distToSupport = currentPrice - sr.support;
      if (distToSupport >= 0 && distToSupport < atrValue * 1.0) {
        conflicts.push({ blocks: 'SELL', reason: `Too close to support ${sr.support.toFixed(2)} (${distToSupport.toFixed(2)} away, need ${(atrValue * 1.0).toFixed(2)})` });
      }
    }

    // ═══════════════════════════════════════════════════════════
    // NEW v5: RANGING MARKET BLOCK
    // If ADX < 20 and regime is RANGING, block trend-following signals
    // Only extreme mean-reversion signals (RSI < 30 or > 70) would pass
    // ═══════════════════════════════════════════════════════════
    const adxValue = ind.adx?.adx || 0;
    if (ctx.regime === 'RANGING' && adxValue < 20) {
      const hasExtremeRSI = ind.rsi < 30 || ind.rsi > 70;
      const hasExtremeStoch = ind.stoch && (ind.stoch.k < 20 || ind.stoch.k > 80);
      if (!hasExtremeRSI && !hasExtremeStoch) {
        conflicts.push({ blocks: 'BOTH', reason: `Ranging market (ADX:${adxValue.toFixed(0)}) — no trend to follow` });
      }
    }

    // ═══════════════════════════════════════════════════════════
    // DECISION LOGIC (same structure as v4)
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

      // Hard block against strong trend (ADX > 30)
      if (action === 'BUY' && ctx.trend === 'BEARISH' && ctx.trendStrength > 30)
        return this.buildResult(symbol, 'HOLD', 0, currentPrice, ind, ctx, [], ['BLOCKED: Strong bearish trend (ADX:' + ctx.trendStrength.toFixed(0) + ')'], 0, 0, 0);
      if (action === 'SELL' && ctx.trend === 'BULLISH' && ctx.trendStrength > 30)
        return this.buildResult(symbol, 'HOLD', 0, currentPrice, ind, ctx, [], ['BLOCKED: Strong bullish trend (ADX:' + ctx.trendStrength.toFixed(0) + ')'], 0, 0, 0);

      // Against weak trend penalty
      if (action === 'BUY' && ctx.trend === 'BEARISH') {
        confidence = Math.round(confidence * 0.5);
        warnings.push('Against bearish trend (-50%)');
      }
      if (action === 'SELL' && ctx.trend === 'BULLISH') {
        confidence = Math.round(confidence * 0.5);
        warnings.push('Against bullish trend (-50%)');
      }

      // With-trend boost — ONLY if ADX confirms (>= 20)
      if (action === 'BUY' && ctx.trend === 'BULLISH' && ctx.trendStrength >= 20) {
        confidence = Math.min(Math.round(confidence * 1.15), 90);
        reasons.push(`With bullish trend (ADX:${ctx.trendStrength.toFixed(0)})`);
      }
      if (action === 'SELL' && ctx.trend === 'BEARISH' && ctx.trendStrength >= 20) {
        confidence = Math.min(Math.round(confidence * 1.15), 90);
        reasons.push(`With bearish trend (ADX:${ctx.trendStrength.toFixed(0)})`);
      }

      // Session
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
        return this.buildResult(symbol, 'HOLD', 0, currentPrice, ind, ctx, [], ['Confidence too low after adjustments'], 0, 0, 0);
    }

    // ═══════════════════════════════════════════════════════════
    // NEW v5: CALCULATE SL/TP AND CHECK R:R BEFORE SENDING
    // ═══════════════════════════════════════════════════════════
    const slMul = ctx.volatility === 'HIGH' ? 2.5 : 2.0;
    let stopLoss = 0, takeProfit = 0, riskReward = 0;

    if (action !== 'HOLD') {
      if (action === 'BUY') {
        stopLoss = currentPrice - (atrValue * slMul);
        // TP: aim for resistance or ATR-based, whichever is FURTHER
        const atrTP = currentPrice + (atrValue * slMul * this.minRR);
        const resistanceTP = sr.resistance > currentPrice ? sr.resistance : atrTP;
        takeProfit = Math.max(atrTP, resistanceTP);
      } else {
        stopLoss = currentPrice + (atrValue * slMul);
        const atrTP = currentPrice - (atrValue * slMul * this.minRR);
        const supportTP = sr.support < currentPrice ? sr.support : atrTP;
        takeProfit = Math.min(atrTP, supportTP);
      }

      // Calculate actual R:R
      const risk = Math.abs(currentPrice - stopLoss);
      const reward = Math.abs(takeProfit - currentPrice);
      riskReward = risk > 0 ? parseFloat((reward / risk).toFixed(2)) : 0;

      // R:R CHECK — reject if below minimum
      if (riskReward < this.minRR) {
        return this.buildResult(symbol, 'HOLD', 0, currentPrice, ind, ctx, [],
          [`R:R too low (${riskReward} < ${this.minRR} minimum)`], 0, 0, 0);
      }
    }

    return {
      symbol, action, confidence, price: currentPrice, stopLoss, takeProfit, riskReward,
      reasons, warnings,
      context: { trend: ctx.trend, trendStrength: ctx.trendStrength, regime: ctx.regime, session: ctx.session, volatility: ctx.volatility, support: ctx.sr.support, resistance: ctx.sr.resistance },
      confluenceCount, eventCount, stateCount,
      indicators: {
        rsi: ind.rsi?.toFixed(2), macd: ind.macd?.histogram?.toFixed(5), adx: ind.adx?.adx?.toFixed(2),
        atr: atrValue?.toFixed(5), stochK: ind.stoch?.k?.toFixed(2), stochD: ind.stoch?.d?.toFixed(2),
        cci: ind.cci?.toFixed(2), ema9: ind.ema9?.toFixed(5), ema21: ind.ema21?.toFixed(5), ema50: ind.ema50?.toFixed(5)
      },
      timestamp: Date.now()
    };
  }

  buildResult(symbol, action, confidence, currentPrice, ind, ctx, reasons, warnings, confluenceCount, eventCount, stateCount) {
    const atrValue = ind.atr || currentPrice * 0.01;
    return {
      symbol, action, confidence, price: currentPrice, stopLoss: 0, takeProfit: 0, riskReward: 0,
      reasons, warnings,
      context: { trend: ctx.trend, trendStrength: ctx.trendStrength, regime: ctx.regime, session: ctx.session, volatility: ctx.volatility, support: ctx.sr.support, resistance: ctx.sr.resistance },
      confluenceCount, eventCount, stateCount,
      indicators: {
        rsi: ind.rsi?.toFixed(2), macd: ind.macd?.histogram?.toFixed(5), adx: ind.adx?.adx?.toFixed(2),
        atr: atrValue?.toFixed(5), stochK: ind.stoch?.k?.toFixed(2), stochD: ind.stoch?.d?.toFixed(2),
        cci: ind.cci?.toFixed(2), ema9: ind.ema9?.toFixed(5), ema21: ind.ema21?.toFixed(5), ema50: ind.ema50?.toFixed(5)
      },
      timestamp: Date.now()
    };
  }
}