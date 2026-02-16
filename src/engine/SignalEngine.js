import { RSI, MACD, EMA, SMA, BollingerBands, ATR, Stochastic, ADX, CCI } from 'technicalindicators';

export class SignalEngine {
  constructor(config = {}) {
    this.candleStore = new Map();
    this.minConfluence = config.minConfluence || 3;
  }

  loadHistoricalCandles(symbol, candles) {
    this.candleStore.set(symbol, [...candles]);
    console.log(`   📊 SignalEngine: Loaded ${candles.length} historical candles for ${symbol}`);
  }

  addCandle(candle) {
    if (!this.candleStore.has(candle.symbol)) {
      this.candleStore.set(candle.symbol, []);
    }
    const store = this.candleStore.get(candle.symbol);
    const last = store[store.length - 1];
    if (last && last.timestamp === candle.timestamp) {
      store[store.length - 1] = candle;
    } else {
      store.push(candle);
      if (store.length > 300) store.shift();
    }
  }

  analyze(symbol) {
    const candles = this.candleStore.get(symbol);
    if (!candles || candles.length < 60) return null;
    const closes = candles.map(c => c.close);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const ind = this.calculateIndicators(closes, highs, lows);
    if (!ind) return null;
    const context = this.getMarketContext(ind, closes, highs, lows);
    return this.generateSignal(symbol, ind, context, closes[closes.length - 1]);
  }

  calculateIndicators(closes, highs, lows) {
    try {
      const rsi = RSI.calculate({ values: closes, period: 14 });
      const macd = MACD.calculate({
        values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
        SimpleMAOscillator: false, SimpleMASignal: false
      });
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
        price: closes[closes.length - 1],
        prevPrice: closes[closes.length - 2],
        rsi: rsi[rsi.length - 1],
        rsiPrev: rsi[rsi.length - 2],
        macd: macd[macd.length - 1],
        macdPrev: macd[macd.length - 2],
        macdPrev2: macd.length > 2 ? macd[macd.length - 3] : null,
        ema9: ema9[ema9.length - 1],
        ema21: ema21[ema21.length - 1],
        ema50: ema50[ema50.length - 1],
        sma200: sma200.length > 0 ? sma200[sma200.length - 1] : null,
        ema9Prev: ema9[ema9.length - 2],
        ema21Prev: ema21[ema21.length - 2],
        bb: bb[bb.length - 1],
        atr: atr[atr.length - 1],
        atr7: atr7.length > 0 ? atr7[atr7.length - 1] : atr[atr.length - 1],
        atrPrev: atr.length > 5 ? atr[atr.length - 5] : atr[atr.length - 1],
        stoch: stoch[stoch.length - 1],
        stochPrev: stoch.length > 1 ? stoch[stoch.length - 2] : null,
        adx: adx[adx.length - 1],
        cci: cci[cci.length - 1],
        cciPrev: cci.length > 1 ? cci[cci.length - 2] : null,
        recentHighs: highs.slice(-30),
        recentLows: lows.slice(-30),
        recentCloses: closes.slice(-30)
      };
    } catch (err) {
      console.error('Indicator calculation error:', err.message);
      return null;
    }
  }

  getMarketContext(ind, closes, highs, lows) {
    const context = {
      trend: 'NEUTRAL', trendStrength: 0, volatility: 'NORMAL',
      session: 'OFF_HOURS', regime: 'RANGING',
      supportResistance: { support: 0, resistance: 0 }
    };

    // Trend
    let ts = 0;
    if (ind.price > ind.ema50) ts++;
    if (ind.sma200 && ind.price > ind.sma200) ts++;
    if (ind.ema9 > ind.ema21) ts++;
    if (ind.ema21 > ind.ema50) ts++;
    if (ts >= 3) { context.trend = 'BULLISH'; context.trendStrength = ind.adx?.adx || 0; }
    else if (ts <= 1) { context.trend = 'BEARISH'; context.trendStrength = ind.adx?.adx || 0; }

    // Volatility
    if (ind.atr7 && ind.atrPrev) {
      const r = ind.atr7 / ind.atrPrev;
      if (r > 1.5) context.volatility = 'HIGH';
      else if (r < 0.7) context.volatility = 'LOW';
    }
    if (ind.bb) {
      const w = (ind.bb.upper - ind.bb.lower) / ind.bb.middle;
      if (w < 0.005) context.volatility = 'SQUEEZE';
    }

    // Session
    const h = new Date().getUTCHours();
    if (h >= 12 && h < 16) context.session = 'OVERLAP';
    else if (h >= 7 && h < 16) context.session = 'LONDON';
    else if (h >= 12 && h < 21) context.session = 'NEW_YORK';
    else if (h >= 23 || h < 8) context.session = 'ASIAN';

    // Regime
    if (ind.adx && ind.adx.adx > 25) context.regime = 'TRENDING';
    else if (context.volatility === 'SQUEEZE') context.regime = 'SQUEEZE';
    const rHigh = Math.max(...highs.slice(-20, -1));
    const rLow = Math.min(...lows.slice(-20, -1));
    if (ind.price > rHigh || ind.price < rLow) context.regime = 'BREAKOUT';

    // S/R
    const lb = Math.min(50, highs.length);
    const rh = highs.slice(-lb), rl = lows.slice(-lb);
    const price = closes[closes.length - 1];
    const sH = [], sL = [];
    for (let i = 2; i < lb - 2; i++) {
      if (rh[i] > rh[i-1] && rh[i] > rh[i-2] && rh[i] > rh[i+1] && rh[i] > rh[i+2]) sH.push(rh[i]);
      if (rl[i] < rl[i-1] && rl[i] < rl[i-2] && rl[i] < rl[i+1] && rl[i] < rl[i+2]) sL.push(rl[i]);
    }
    context.supportResistance = {
      resistance: sH.filter(v => v > price).sort((a,b) => a-b)[0] || Math.max(...rh),
      support: sL.filter(v => v < price).sort((a,b) => b-a)[0] || Math.min(...rl)
    };

    return context;
  }

  // ═══════════════════════════════════════════════════════════════
  // SIGNAL GENERATION v3
  //
  // FIXES from v2:
  //  1. No double counting (MACD crossover blocks MACD state)
  //  2. RSI/Stoch in neutral zone does NOT generate signals
  //  3. CONFLICT DETECTION - opposing indicators BLOCK the signal
  //  4. Stronger against-trend penalty (50% instead of 30%)
  //  5. Lower confidence scaling (more honest percentages)
  //  6. ADX minimum for breakout signals
  //  7. Squeeze breakout only with ADX confirmation
  // ═══════════════════════════════════════════════════════════════
  generateSignal(symbol, ind, context, currentPrice) {
    const buyEvents = [], sellEvents = [];
    const buyState = [], sellState = [];
    const buyConflicts = [], sellConflicts = []; // NEW: track conflicts

    // Track which indicators fired events (to prevent double counting)
    const eventSources = new Set();

    // ─── EVENTS (crossovers - the trigger) ───

    // EMA 9/21 crossover
    if (ind.ema9 > ind.ema21 && ind.ema9Prev <= ind.ema21Prev) {
      buyEvents.push('EMA 9/21 bullish crossover');
      eventSources.add('ema');
    } else if (ind.ema9 < ind.ema21 && ind.ema9Prev >= ind.ema21Prev) {
      sellEvents.push('EMA 9/21 bearish crossover');
      eventSources.add('ema');
    }

    // MACD crossover
    if (ind.macd && ind.macdPrev) {
      if (ind.macd.MACD > ind.macd.signal && ind.macdPrev.MACD <= ind.macdPrev.signal) {
        buyEvents.push('MACD bullish crossover');
        eventSources.add('macd');
      } else if (ind.macd.MACD < ind.macd.signal && ind.macdPrev.MACD >= ind.macdPrev.signal) {
        sellEvents.push('MACD bearish crossover');
        eventSources.add('macd');
      }
    }

    // Stochastic crossover in extreme zones (20/80 - tighter than v2)
    if (ind.stoch && ind.stochPrev) {
      if (ind.stoch.k < 20 && ind.stoch.k > ind.stoch.d && ind.stochPrev.k <= ind.stochPrev.d) {
        buyEvents.push('Stochastic bullish crossover (oversold)');
        eventSources.add('stoch');
      } else if (ind.stoch.k > 80 && ind.stoch.k < ind.stoch.d && ind.stochPrev.k >= ind.stochPrev.d) {
        sellEvents.push('Stochastic bearish crossover (overbought)');
        eventSources.add('stoch');
      }
    }

    // CCI crossover
    if (ind.cci !== undefined && ind.cciPrev !== undefined) {
      if (ind.cci > -100 && ind.cciPrev <= -100) {
        buyEvents.push('CCI crossing above -100');
        eventSources.add('cci');
      } else if (ind.cci < 100 && ind.cciPrev >= 100) {
        sellEvents.push('CCI crossing below 100');
        eventSources.add('cci');
      }
    }

    // Breakout — ONLY if ADX shows some trend strength
    const rHigh = Math.max(...ind.recentHighs.slice(0, -1));
    const rLow = Math.min(...ind.recentLows.slice(0, -1));
    if (ind.price > rHigh && ind.adx && ind.adx.adx > 20) {
      buyEvents.push('Breakout above recent high');
      eventSources.add('breakout');
    } else if (ind.price < rLow && ind.adx && ind.adx.adx > 20) {
      sellEvents.push('Breakdown below recent low');
      eventSources.add('breakout');
    }

    // RSI exiting extreme
    if (ind.rsi && ind.rsiPrev) {
      if (ind.rsi > 30 && ind.rsiPrev <= 30) {
        buyEvents.push('RSI exiting oversold');
        eventSources.add('rsi');
      } else if (ind.rsi < 70 && ind.rsiPrev >= 70) {
        sellEvents.push('RSI exiting overbought');
        eventSources.add('rsi');
      }
    }

    // ─── STATE SIGNALS (confirms direction — NO double counting) ───

    // EMA alignment — only if EMA crossover didn't fire
    if (!eventSources.has('ema')) {
      if (ind.ema9 > ind.ema21 && ind.ema21 > ind.ema50)
        buyState.push('EMA bullish alignment (9>21>50)');
      else if (ind.ema9 < ind.ema21 && ind.ema21 < ind.ema50)
        sellState.push('EMA bearish alignment (9<21<50)');
    }

    // Price vs key EMAs
    if (ind.price > ind.ema21 && ind.price > ind.ema50)
      buyState.push('Price above EMA 21 & 50');
    else if (ind.price < ind.ema21 && ind.price < ind.ema50)
      sellState.push('Price below EMA 21 & 50');

    // MACD position — only if MACD crossover didn't fire (NO DOUBLE COUNTING)
    if (!eventSources.has('macd')) {
      if (ind.macd && ind.macd.MACD > ind.macd.signal && ind.macd.histogram > 0)
        buyState.push('MACD bullish');
      else if (ind.macd && ind.macd.MACD < ind.macd.signal && ind.macd.histogram < 0)
        sellState.push('MACD bearish');
    }

    // MACD histogram momentum (3 bars accelerating) — only if no MACD event
    if (!eventSources.has('macd') && ind.macd && ind.macdPrev && ind.macdPrev2) {
      if (ind.macd.histogram > ind.macdPrev.histogram && 
          ind.macdPrev.histogram > ind.macdPrev2.histogram &&
          ind.macd.histogram > 0) {
        buyState.push('MACD momentum building');
      } else if (ind.macd.histogram < ind.macdPrev.histogram && 
                 ind.macdPrev.histogram < ind.macdPrev2.histogram &&
                 ind.macd.histogram < 0) {
        sellState.push('MACD sell momentum');
      }
    }

    // RSI zones — ONLY in meaningful zones, NOT neutral (40-60 = NO SIGNAL)
    if (ind.rsi < 35) buyState.push(`RSI oversold zone (${ind.rsi.toFixed(1)})`);
    else if (ind.rsi > 65) sellState.push(`RSI overbought zone (${ind.rsi.toFixed(1)})`);

    // RSI direction — ONLY when RSI is already in a meaningful zone
    if (ind.rsiPrev) {
      if (ind.rsi > ind.rsiPrev && ind.rsi < 40) buyState.push('RSI rising from low');
      else if (ind.rsi < ind.rsiPrev && ind.rsi > 60) sellState.push('RSI falling from high');
    }

    // Stochastic position — only if no stoch event
    if (!eventSources.has('stoch') && ind.stoch) {
      if (ind.stoch.k < 25 && ind.stoch.d < 25) buyState.push('Stochastic oversold');
      else if (ind.stoch.k > 75 && ind.stoch.d > 75) sellState.push('Stochastic overbought');
    }

    // Bollinger band position
    if (ind.bb) {
      const pB = (ind.price - ind.bb.lower) / (ind.bb.upper - ind.bb.lower);
      if (pB < 0.10) buyState.push('Price at lower Bollinger Band');
      else if (pB > 0.90) sellState.push('Price at upper Bollinger Band');
    }

    // ADX direction — only counts if ADX is strong enough (>22)
    if (ind.adx && ind.adx.adx > 22) {
      if (ind.adx.pdi > ind.adx.mdi) buyState.push(`ADX bullish (${ind.adx.adx.toFixed(0)})`);
      else sellState.push(`ADX bearish (${ind.adx.adx.toFixed(0)})`);
    }

    // SMA 200
    if (ind.sma200) {
      if (ind.price > ind.sma200) buyState.push('Above SMA 200');
      else sellState.push('Below SMA 200');
    }

    // ═══════════════════════════════════════════════════════════
    // CONFLICT DETECTION — opposing signals that BLOCK the trade
    // This is the key fix: if strong opposing indicators exist,
    // the signal gets killed or heavily penalized
    // ═══════════════════════════════════════════════════════════

    // Stochastic conflicts
    if (ind.stoch) {
      if (ind.stoch.k < 25) sellConflicts.push(`Stochastic oversold (${ind.stoch.k.toFixed(0)}) — don't sell`);
      if (ind.stoch.k > 75) buyConflicts.push(`Stochastic overbought (${ind.stoch.k.toFixed(0)}) — don't buy`);
    }

    // RSI conflicts
    if (ind.rsi < 30) sellConflicts.push(`RSI oversold (${ind.rsi.toFixed(0)}) — don't sell`);
    if (ind.rsi > 70) buyConflicts.push(`RSI overbought (${ind.rsi.toFixed(0)}) — don't buy`);

    // Bollinger conflicts
    if (ind.bb) {
      const pB = (ind.price - ind.bb.lower) / (ind.bb.upper - ind.bb.lower);
      if (pB < 0.05) sellConflicts.push('Price at extreme lower BB — don\'t sell');
      if (pB > 0.95) buyConflicts.push('Price at extreme upper BB — don\'t buy');
    }

    // CCI conflicts
    if (ind.cci < -200) sellConflicts.push('CCI extremely oversold — don\'t sell');
    if (ind.cci > 200) buyConflicts.push('CCI extremely overbought — don\'t buy');

    // ═══════════════════════════════════════════════════════════
    // DECISION LOGIC
    //
    // Requirements:
    //  1. At least 1 EVENT (something just happened)
    //  2. EVENT + STATE >= minConfluence
    //  3. Buy total > Sell total (clear direction)
    //  4. NO hard conflicts (stoch oversold blocks sell, etc.)
    //  5. NOT against a strong trend
    // ═══════════════════════════════════════════════════════════

    const totalBuy = buyEvents.length + buyState.length;
    const totalSell = sellEvents.length + sellState.length;

    let action = 'HOLD', confidence = 0, reasons = [], warnings = [];
    let confluenceCount = 0, eventCount = 0, stateCount = 0;

    // Check for hard conflicts first
    const buyBlocked = buyConflicts.length > 0;
    const sellBlocked = sellConflicts.length > 0;

    if (buyEvents.length >= 1 && totalBuy >= this.minConfluence && totalBuy > totalSell && !buyBlocked) {
      action = 'BUY';
      confluenceCount = totalBuy;
      eventCount = buyEvents.length;
      stateCount = buyState.length;
      reasons = [...buyEvents, ...buyState];

      // Confidence: more conservative scaling
      // 3 signals = 40%, 4 = 48%, 5 = 55%, 6 = 62%, 7 = 68%, 8+ = 75%+
      confidence = Math.min(25 + (confluenceCount * 8), 85);
      if (buyEvents.length >= 2) confidence = Math.min(confidence + 8, 88);

    } else if (sellEvents.length >= 1 && totalSell >= this.minConfluence && totalSell > totalBuy && !sellBlocked) {
      action = 'SELL';
      confluenceCount = totalSell;
      eventCount = sellEvents.length;
      stateCount = sellState.length;
      reasons = [...sellEvents, ...sellState];

      confidence = Math.min(25 + (confluenceCount * 8), 85);
      if (sellEvents.length >= 2) confidence = Math.min(confidence + 8, 88);
    }

    // If blocked by conflict, report it in debug
    if (action === 'HOLD') {
      if (buyEvents.length >= 1 && buyBlocked) {
        warnings = buyConflicts.map(c => `BLOCKED: ${c}`);
      } else if (sellEvents.length >= 1 && sellBlocked) {
        warnings = sellConflicts.map(c => `BLOCKED: ${c}`);
      }
    }

    // ── CONTEXT ADJUSTMENTS ──
    if (action !== 'HOLD') {

      // HARD BLOCK: Don't trade against strong trend (ADX > 30)
      if (action === 'BUY' && context.trend === 'BEARISH' && context.trendStrength > 30) {
        action = 'HOLD';
        confidence = 0;
        warnings.push('BLOCKED: Strong bearish trend (ADX > 30)');
        return this.buildResult(symbol, 'HOLD', 0, currentPrice, ind, context, [], warnings, 0, 0, 0);
      }
      if (action === 'SELL' && context.trend === 'BULLISH' && context.trendStrength > 30) {
        action = 'HOLD';
        confidence = 0;
        warnings.push('BLOCKED: Strong bullish trend (ADX > 30)');
        return this.buildResult(symbol, 'HOLD', 0, currentPrice, ind, context, [], warnings, 0, 0, 0);
      }

      // Moderate penalty: against weak trend (ADX 20-30)
      if (action === 'BUY' && context.trend === 'BEARISH') {
        confidence = Math.round(confidence * 0.5);
        warnings.push('Against bearish trend (-50%)');
      }
      if (action === 'SELL' && context.trend === 'BULLISH') {
        confidence = Math.round(confidence * 0.5);
        warnings.push('Against bullish trend (-50%)');
      }

      // Boost with-trend
      if (action === 'BUY' && context.trend === 'BULLISH') {
        confidence = Math.min(Math.round(confidence * 1.15), 90);
        reasons.push('With bullish trend');
      }
      if (action === 'SELL' && context.trend === 'BEARISH') {
        confidence = Math.min(Math.round(confidence * 1.15), 90);
        reasons.push('With bearish trend');
      }

      // Session adjustments
      if (context.session === 'OVERLAP') {
        confidence = Math.min(Math.round(confidence * 1.1), 90);
        reasons.push('London/NY overlap');
      } else if (context.session === 'LONDON' || context.session === 'NEW_YORK') {
        confidence = Math.min(Math.round(confidence * 1.05), 90);
      } else if (context.session === 'ASIAN') {
        confidence = Math.round(confidence * 0.85);
        warnings.push('Asian session (-15%)');
      }

      // High volatility
      if (context.volatility === 'HIGH') {
        confidence = Math.round(confidence * 0.9);
        warnings.push('High volatility');
      }

      // Squeeze — only boost if ADX is rising (real breakout, not fake)
      if (context.regime === 'SQUEEZE' && ind.adx && ind.adx.adx > 20) {
        confidence = Math.min(Math.round(confidence * 1.08), 90);
        reasons.push('Squeeze breakout (ADX confirming)');
      }

      // Final minimum check — after all adjustments, still need 40%+
      if (confidence < 40) {
        action = 'HOLD';
        confidence = 0;
        warnings.push('Confidence too low after adjustments');
      }
    }

    return this.buildResult(symbol, action, confidence, currentPrice, ind, context, reasons, warnings, confluenceCount, eventCount, stateCount);
  }

  buildResult(symbol, action, confidence, currentPrice, ind, context, reasons, warnings, confluenceCount, eventCount, stateCount) {
    const atrValue = ind.atr || currentPrice * 0.01;
    const slMul = context.volatility === 'HIGH' ? 2.5 : 2.0;
    const tpMul = context.regime === 'TRENDING' ? 3.0 : 2.0;

    let stopLoss, takeProfit;
    if (action === 'BUY') {
      stopLoss = currentPrice - (atrValue * slMul);
      takeProfit = currentPrice + (atrValue * tpMul);
    } else if (action === 'SELL') {
      stopLoss = currentPrice + (atrValue * slMul);
      takeProfit = currentPrice - (atrValue * tpMul);
    } else {
      stopLoss = 0;
      takeProfit = 0;
    }

    return {
      symbol, action, confidence, price: currentPrice, stopLoss, takeProfit,
      riskReward: action !== 'HOLD' ? parseFloat((tpMul / slMul).toFixed(2)) : 0,
      reasons, warnings,
      context: {
        trend: context.trend, trendStrength: context.trendStrength,
        regime: context.regime, session: context.session, volatility: context.volatility,
        support: context.supportResistance.support, resistance: context.supportResistance.resistance
      },
      confluenceCount, eventCount, stateCount,
      indicators: {
        rsi: ind.rsi?.toFixed(2), macd: ind.macd?.histogram?.toFixed(5),
        adx: ind.adx?.adx?.toFixed(2), atr: atrValue?.toFixed(5),
        stochK: ind.stoch?.k?.toFixed(2), stochD: ind.stoch?.d?.toFixed(2),
        cci: ind.cci?.toFixed(2),
        ema9: ind.ema9?.toFixed(5), ema21: ind.ema21?.toFixed(5), ema50: ind.ema50?.toFixed(5)
      },
      timestamp: Date.now()
    };
  }
}