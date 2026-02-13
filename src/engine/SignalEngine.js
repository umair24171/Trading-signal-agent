import { RSI, MACD, EMA, SMA, BollingerBands, ATR, Stochastic, ADX, CCI } from 'technicalindicators';

export class SignalEngine {
  constructor(config = {}) {
    this.candleStore = new Map(); // symbol -> candles[]
    this.signalHistory = new Map(); // symbol -> last signals for tracking
    
    // Require minimum confirmations for a signal (confluence)
    this.minConfluence = config.minConfluence || 3;
    
    // Session config (UTC hours)
    this.sessions = {
      london: { start: 7, end: 16 },    // London session
      newYork: { start: 12, end: 21 },   // NY session  
      overlap: { start: 12, end: 16 },   // Best volatility
      asian: { start: 23, end: 8 }       // Asian session (quieter)
    };
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
      if (store.length > 300) store.shift(); // Keep more history
    }
  }

  analyze(symbol) {
    const candles = this.candleStore.get(symbol);
    if (!candles || candles.length < 60) return null;

    const closes = candles.map(c => c.close);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const volumes = candles.map(c => c.volume);

    const indicators = this.calculateIndicators(closes, highs, lows, volumes);
    if (!indicators) return null;

    // Detect market context first
    const context = this.getMarketContext(indicators, closes, highs, lows);
    
    // Generate signal with context awareness
    return this.generateSignal(symbol, indicators, context, closes[closes.length - 1]);
  }

  calculateIndicators(closes, highs, lows, volumes) {
    try {
      const rsi = RSI.calculate({ values: closes, period: 14 });
      const rsi7 = RSI.calculate({ values: closes, period: 7 }); // Fast RSI for divergence
      
      const macd = MACD.calculate({
        values: closes,
        fastPeriod: 12,
        slowPeriod: 26,
        signalPeriod: 9,
        SimpleMAOscillator: false,
        SimpleMASignal: false
      });

      const ema9 = EMA.calculate({ values: closes, period: 9 });
      const ema21 = EMA.calculate({ values: closes, period: 21 });
      const ema50 = EMA.calculate({ values: closes, period: 50 });
      const sma200 = SMA.calculate({ values: closes, period: Math.min(200, closes.length - 1) });
      
      const bb = BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 });
      const bbNarrow = BollingerBands.calculate({ values: closes, period: 20, stdDev: 1 }); // For squeeze detection
      
      const atr = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
      const atr7 = ATR.calculate({ high: highs, low: lows, close: closes, period: 7 });
      
      const stoch = Stochastic.calculate({ high: highs, low: lows, close: closes, period: 14, signalPeriod: 3 });
      const adx = ADX.calculate({ high: highs, low: lows, close: closes, period: 14 });

      // CCI for additional confirmation
      const cci = CCI.calculate({ high: highs, low: lows, close: closes, period: 20 });

      return {
        price: closes[closes.length - 1],
        prevPrice: closes[closes.length - 2],
        
        // RSI
        rsi: rsi[rsi.length - 1],
        rsiPrev: rsi[rsi.length - 2],
        rsiPrev2: rsi[rsi.length - 3],
        rsi7: rsi7[rsi7.length - 1],
        
        // MACD
        macd: macd[macd.length - 1],
        macdPrev: macd[macd.length - 2],
        macdPrev2: macd[macd.length - 3],
        
        // EMAs
        ema9: ema9[ema9.length - 1],
        ema21: ema21[ema21.length - 1],
        ema50: ema50[ema50.length - 1],
        sma200: sma200.length > 0 ? sma200[sma200.length - 1] : null,
        
        ema9Prev: ema9[ema9.length - 2],
        ema21Prev: ema21[ema21.length - 2],
        
        // Bollinger Bands
        bb: bb[bb.length - 1],
        bbPrev: bb[bb.length - 2],
        bbNarrow: bbNarrow[bbNarrow.length - 1],
        
        // ATR
        atr: atr[atr.length - 1],
        atr7: atr7.length > 0 ? atr7[atr7.length - 1] : atr[atr.length - 1],
        atrPrev: atr[atr.length - 5] || atr[atr.length - 1], // For volatility expansion check
        
        // Stochastic
        stoch: stoch[stoch.length - 1],
        stochPrev: stoch[stoch.length - 2],
        
        // ADX
        adx: adx[adx.length - 1],
        adxPrev: adx[adx.length - 2],
        
        // CCI
        cci: cci[cci.length - 1],
        cciPrev: cci[cci.length - 2],
        
        // Price action data
        recentHighs: highs.slice(-30),
        recentLows: lows.slice(-30),
        recentCloses: closes.slice(-30),
        
        // For pattern detection
        last5Candles: {
          closes: closes.slice(-5),
          highs: highs.slice(-5),
          lows: lows.slice(-5)
        }
      };
    } catch (err) {
      console.error('Indicator calculation error:', err.message);
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // MARKET CONTEXT - Understand WHAT the market is doing first
  // ═══════════════════════════════════════════════════════════════
  getMarketContext(ind, closes, highs, lows) {
    const context = {
      trend: 'NEUTRAL',        // BULLISH, BEARISH, NEUTRAL
      trendStrength: 0,        // 0-100
      volatility: 'NORMAL',    // LOW, NORMAL, HIGH
      session: 'OFF_HOURS',    // LONDON, NEW_YORK, OVERLAP, ASIAN, OFF_HOURS
      regime: 'RANGING',       // TRENDING, RANGING, BREAKOUT
      supportResistance: { support: 0, resistance: 0 }
    };

    // ── TREND DETECTION ──
    // Use EMA alignment + price position
    const priceAboveEma50 = ind.price > ind.ema50;
    const priceAboveSma200 = ind.sma200 ? ind.price > ind.sma200 : null;
    const ema9AboveEma21 = ind.ema9 > ind.ema21;
    const ema21AboveEma50 = ind.ema21 > ind.ema50;

    let trendScore = 0;
    if (priceAboveEma50) trendScore += 1;
    if (priceAboveSma200) trendScore += 1;
    if (ema9AboveEma21) trendScore += 1;
    if (ema21AboveEma50) trendScore += 1;

    if (trendScore >= 3) {
      context.trend = 'BULLISH';
      context.trendStrength = ind.adx?.adx || 0;
    } else if (trendScore <= 1) {
      context.trend = 'BEARISH';
      context.trendStrength = ind.adx?.adx || 0;
    } else {
      context.trend = 'NEUTRAL';
      context.trendStrength = 0;
    }

    // ── VOLATILITY ──
    if (ind.atr7 && ind.atrPrev) {
      const volatilityRatio = ind.atr7 / ind.atrPrev;
      if (volatilityRatio > 1.5) context.volatility = 'HIGH';
      else if (volatilityRatio < 0.7) context.volatility = 'LOW';
    }

    // Bollinger Band squeeze detection
    if (ind.bb) {
      const bbWidth = (ind.bb.upper - ind.bb.lower) / ind.bb.middle;
      if (bbWidth < 0.01) context.volatility = 'LOW'; // Squeeze = low vol
    }

    // ── MARKET SESSION ──
    const utcHour = new Date().getUTCHours();
    if (utcHour >= 12 && utcHour < 16) context.session = 'OVERLAP';
    else if (utcHour >= 7 && utcHour < 16) context.session = 'LONDON';
    else if (utcHour >= 12 && utcHour < 21) context.session = 'NEW_YORK';
    else if (utcHour >= 23 || utcHour < 8) context.session = 'ASIAN';

    // ── REGIME ──
    if (ind.adx && ind.adx.adx > 25) {
      context.regime = 'TRENDING';
    } else if (context.volatility === 'LOW') {
      context.regime = 'RANGING'; // Could break out soon
    }

    // Check for breakout
    const recentHigh = Math.max(...highs.slice(-20, -1));
    const recentLow = Math.min(...lows.slice(-20, -1));
    if (ind.price > recentHigh || ind.price < recentLow) {
      context.regime = 'BREAKOUT';
    }

    // ── SUPPORT & RESISTANCE ──
    context.supportResistance = this.findSupportResistance(closes, highs, lows);

    return context;
  }

  findSupportResistance(closes, highs, lows) {
    // Simple pivot-based S/R from last 50 candles
    const lookback = Math.min(50, highs.length);
    const recentHighs = highs.slice(-lookback);
    const recentLows = lows.slice(-lookback);
    const currentPrice = closes[closes.length - 1];

    // Find swing highs and lows
    const swingHighs = [];
    const swingLows = [];

    for (let i = 2; i < lookback - 2; i++) {
      if (recentHighs[i] > recentHighs[i-1] && recentHighs[i] > recentHighs[i-2] &&
          recentHighs[i] > recentHighs[i+1] && recentHighs[i] > recentHighs[i+2]) {
        swingHighs.push(recentHighs[i]);
      }
      if (recentLows[i] < recentLows[i-1] && recentLows[i] < recentLows[i-2] &&
          recentLows[i] < recentLows[i+1] && recentLows[i] < recentLows[i+2]) {
        swingLows.push(recentLows[i]);
      }
    }

    // Nearest resistance above price
    const resistance = swingHighs
      .filter(h => h > currentPrice)
      .sort((a, b) => a - b)[0] || Math.max(...recentHighs);

    // Nearest support below price
    const support = swingLows
      .filter(l => l < currentPrice)
      .sort((a, b) => b - a)[0] || Math.min(...recentLows);

    return { support, resistance };
  }

  // ═══════════════════════════════════════════════════════════════
  // SIGNAL GENERATION - Confluence-based with context
  // ═══════════════════════════════════════════════════════════════
  generateSignal(symbol, ind, context, currentPrice) {
    const buySignals = [];
    const sellSignals = [];

    // ─────────────────────────────────────────
    // SIGNAL 1: EMA CROSSOVER (Trend following)
    // ─────────────────────────────────────────
    if (ind.ema9 > ind.ema21 && ind.ema9Prev <= ind.ema21Prev) {
      buySignals.push({ name: 'EMA 9/21 bullish crossover', weight: 2 });
    } else if (ind.ema9 < ind.ema21 && ind.ema9Prev >= ind.ema21Prev) {
      sellSignals.push({ name: 'EMA 9/21 bearish crossover', weight: 2 });
    }

    // EMA alignment (all aligned = strong trend)
    if (ind.ema9 > ind.ema21 && ind.ema21 > ind.ema50) {
      buySignals.push({ name: 'Full EMA bullish alignment', weight: 1.5 });
    } else if (ind.ema9 < ind.ema21 && ind.ema21 < ind.ema50) {
      sellSignals.push({ name: 'Full EMA bearish alignment', weight: 1.5 });
    }

    // ─────────────────────────────────────────
    // SIGNAL 2: MACD (Momentum)
    // ─────────────────────────────────────────
    if (ind.macd && ind.macdPrev) {
      // Bullish crossover
      if (ind.macd.MACD > ind.macd.signal && ind.macdPrev.MACD <= ind.macdPrev.signal) {
        const weight = ind.macd.histogram > 0 ? 2 : 1.5;
        buySignals.push({ name: 'MACD bullish crossover', weight });
      }
      // Bearish crossover
      else if (ind.macd.MACD < ind.macd.signal && ind.macdPrev.MACD >= ind.macdPrev.signal) {
        const weight = ind.macd.histogram < 0 ? 2 : 1.5;
        sellSignals.push({ name: 'MACD bearish crossover', weight });
      }
      
      // MACD histogram increasing (momentum building)
      if (ind.macdPrev2) {
        const histChange = ind.macd.histogram - ind.macdPrev.histogram;
        const prevHistChange = ind.macdPrev.histogram - ind.macdPrev2.histogram;
        if (histChange > 0 && prevHistChange > 0 && ind.macd.histogram > 0) {
          buySignals.push({ name: 'MACD momentum accelerating', weight: 1 });
        } else if (histChange < 0 && prevHistChange < 0 && ind.macd.histogram < 0) {
          sellSignals.push({ name: 'MACD momentum accelerating down', weight: 1 });
        }
      }
    }

    // ─────────────────────────────────────────
    // SIGNAL 3: RSI (Momentum + Divergence)
    // ─────────────────────────────────────────
    // Standard oversold/overbought
    if (ind.rsi < 30) {
      buySignals.push({ name: `RSI oversold (${ind.rsi.toFixed(1)})`, weight: 1.5 });
    } else if (ind.rsi > 70) {
      sellSignals.push({ name: `RSI overbought (${ind.rsi.toFixed(1)})`, weight: 1.5 });
    }

    // RSI divergence (price makes new low but RSI doesn't - bullish)
    if (ind.rsiPrev2 && ind.rsiPrev) {
      const priceMakingLowerLow = ind.price < ind.prevPrice;
      const rsiMakingHigherLow = ind.rsi > ind.rsiPrev;
      if (priceMakingLowerLow && rsiMakingHigherLow && ind.rsi < 40) {
        buySignals.push({ name: 'RSI bullish divergence', weight: 2 });
      }
      
      const priceMakingHigherHigh = ind.price > ind.prevPrice;
      const rsiMakingLowerHigh = ind.rsi < ind.rsiPrev;
      if (priceMakingHigherHigh && rsiMakingLowerHigh && ind.rsi > 60) {
        sellSignals.push({ name: 'RSI bearish divergence', weight: 2 });
      }
    }

    // ─────────────────────────────────────────
    // SIGNAL 4: BOLLINGER BANDS (Mean reversion + Breakout)
    // ─────────────────────────────────────────
    if (ind.bb) {
      const percentB = (ind.price - ind.bb.lower) / (ind.bb.upper - ind.bb.lower);
      
      // Mean reversion: price at bands in ranging market
      if (context.regime === 'RANGING') {
        if (percentB < 0.05) {
          buySignals.push({ name: 'Price at lower BB (ranging)', weight: 1.5 });
        } else if (percentB > 0.95) {
          sellSignals.push({ name: 'Price at upper BB (ranging)', weight: 1.5 });
        }
      }
      
      // Breakout: price breaking bands in trending market with volume
      if (context.regime === 'TRENDING' || context.regime === 'BREAKOUT') {
        if (percentB > 1.0 && context.trend === 'BULLISH') {
          buySignals.push({ name: 'BB breakout (bullish trend)', weight: 1.5 });
        } else if (percentB < 0.0 && context.trend === 'BEARISH') {
          sellSignals.push({ name: 'BB breakdown (bearish trend)', weight: 1.5 });
        }
      }
    }

    // ─────────────────────────────────────────
    // SIGNAL 5: STOCHASTIC (Momentum in extremes)
    // ─────────────────────────────────────────
    if (ind.stoch && ind.stochPrev) {
      if (ind.stoch.k < 20 && ind.stoch.k > ind.stoch.d && ind.stochPrev.k <= ind.stochPrev.d) {
        buySignals.push({ name: 'Stochastic bullish crossover (oversold)', weight: 1.5 });
      } else if (ind.stoch.k > 80 && ind.stoch.k < ind.stoch.d && ind.stochPrev.k >= ind.stochPrev.d) {
        sellSignals.push({ name: 'Stochastic bearish crossover (overbought)', weight: 1.5 });
      }
    }

    // ─────────────────────────────────────────
    // SIGNAL 6: CCI (Commodity Channel Index)
    // ─────────────────────────────────────────
    if (ind.cci !== undefined && ind.cciPrev !== undefined) {
      if (ind.cci > -100 && ind.cciPrev <= -100) {
        buySignals.push({ name: 'CCI crossing above -100', weight: 1 });
      } else if (ind.cci < 100 && ind.cciPrev >= 100) {
        sellSignals.push({ name: 'CCI crossing below 100', weight: 1 });
      }
    }

    // ─────────────────────────────────────────
    // SIGNAL 7: BREAKOUT (Price action)
    // ─────────────────────────────────────────
    const recentHigh = Math.max(...ind.recentHighs.slice(0, -1));
    const recentLow = Math.min(...ind.recentLows.slice(0, -1));

    if (ind.price > recentHigh) {
      buySignals.push({ name: 'Breakout above 30-bar high', weight: 2 });
    } else if (ind.price < recentLow) {
      sellSignals.push({ name: 'Breakdown below 30-bar low', weight: 2 });
    }

    // ─────────────────────────────────────────
    // SIGNAL 8: SUPPORT/RESISTANCE PROXIMITY
    // ─────────────────────────────────────────
    const sr = context.supportResistance;
    const atrValue = ind.atr || currentPrice * 0.01;
    
    if (Math.abs(currentPrice - sr.support) < atrValue * 0.5) {
      buySignals.push({ name: 'Price near support level', weight: 1 });
    }
    if (Math.abs(currentPrice - sr.resistance) < atrValue * 0.5) {
      sellSignals.push({ name: 'Price near resistance level', weight: 1 });
    }

    // ═══════════════════════════════════════════════════════════
    // CONFLUENCE CHECK + CONTEXT FILTERS
    // ═══════════════════════════════════════════════════════════

    const buyWeight = buySignals.reduce((sum, s) => sum + s.weight, 0);
    const sellWeight = sellSignals.reduce((sum, s) => sum + s.weight, 0);
    const buyCount = buySignals.length;
    const sellCount = sellSignals.length;

    let action = 'HOLD';
    let confidence = 0;
    let reasons = [];
    let warnings = [];

    // ── CONFLUENCE REQUIREMENT: Need 3+ confirming signals ──
    if (buyCount >= this.minConfluence && buyWeight > sellWeight * 1.5) {
      action = 'BUY';
      confidence = Math.min(Math.round(buyWeight * 8), 100); // Scale to 100
      reasons = buySignals.map(s => s.name);
    } else if (sellCount >= this.minConfluence && sellWeight > buyWeight * 1.5) {
      action = 'SELL';
      confidence = Math.min(Math.round(sellWeight * 8), 100);
      reasons = sellSignals.map(s => s.name);
    }

    // ── CONTEXT FILTERS (can reduce confidence or block) ──
    if (action !== 'HOLD') {
      // Filter 1: Don't trade against strong trend
      if (action === 'BUY' && context.trend === 'BEARISH' && context.trendStrength > 30) {
        confidence = Math.round(confidence * 0.5);
        warnings.push('⚠️ Against bearish trend');
      }
      if (action === 'SELL' && context.trend === 'BULLISH' && context.trendStrength > 30) {
        confidence = Math.round(confidence * 0.5);
        warnings.push('⚠️ Against bullish trend');
      }

      // Filter 2: Boost during high-activity sessions
      if (context.session === 'OVERLAP') {
        confidence = Math.min(Math.round(confidence * 1.15), 100);
        reasons.push('London/NY overlap session');
      } else if (context.session === 'LONDON' || context.session === 'NEW_YORK') {
        confidence = Math.min(Math.round(confidence * 1.05), 100);
      }

      // Filter 3: Boost if ADX confirms trend strength
      if (ind.adx && ind.adx.adx > 25) {
        const adxBoost = (action === 'BUY' && ind.adx.pdi > ind.adx.mdi) ||
                         (action === 'SELL' && ind.adx.mdi > ind.adx.pdi);
        if (adxBoost) {
          confidence = Math.min(Math.round(confidence * 1.1), 100);
          reasons.push(`ADX confirms (${ind.adx.adx.toFixed(1)})`);
        } else {
          confidence = Math.round(confidence * 0.8);
          warnings.push('ADX direction mismatch');
        }
      }

      // Filter 4: High volatility = wider stops needed, lower confidence
      if (context.volatility === 'HIGH') {
        confidence = Math.round(confidence * 0.9);
        warnings.push('High volatility');
      }
    }

    // ── CALCULATE DYNAMIC STOP LOSS & TAKE PROFIT ──
    const atrMultiplierSL = context.volatility === 'HIGH' ? 2.5 : 2.0;
    const atrMultiplierTP = context.regime === 'TRENDING' ? 3.5 : 2.5;
    
    const stopLoss = action === 'BUY'
      ? currentPrice - (atrValue * atrMultiplierSL)
      : currentPrice + (atrValue * atrMultiplierSL);
    const takeProfit = action === 'BUY'
      ? currentPrice + (atrValue * atrMultiplierTP)
      : currentPrice - (atrValue * atrMultiplierTP);

    const riskReward = atrMultiplierTP / atrMultiplierSL;

    return {
      symbol,
      action,
      confidence,
      price: currentPrice,
      stopLoss,
      takeProfit,
      riskReward: parseFloat(riskReward.toFixed(2)),
      reasons,
      warnings,
      context: {
        trend: context.trend,
        trendStrength: context.trendStrength,
        regime: context.regime,
        session: context.session,
        volatility: context.volatility,
        support: context.supportResistance.support,
        resistance: context.supportResistance.resistance
      },
      confluenceCount: action === 'BUY' ? buyCount : (action === 'SELL' ? sellCount : 0),
      indicators: {
        rsi: ind.rsi?.toFixed(2),
        macd: ind.macd?.histogram?.toFixed(5),
        adx: ind.adx?.adx?.toFixed(2),
        atr: atrValue?.toFixed(5),
        stochK: ind.stoch?.k?.toFixed(2),
        cci: ind.cci?.toFixed(2),
        ema9: ind.ema9?.toFixed(5),
        ema21: ind.ema21?.toFixed(5),
        ema50: ind.ema50?.toFixed(5)
      },
      timestamp: Date.now()
    };
  }
}