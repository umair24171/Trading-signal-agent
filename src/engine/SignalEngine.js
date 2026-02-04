import { RSI, MACD, EMA, SMA, BollingerBands, ATR, Stochastic, ADX } from 'technicalindicators';

export class SignalEngine {
  constructor() {
    this.candleStore = new Map(); // symbol -> candles[]
  }

  addCandle(candle) {
    if (!this.candleStore.has(candle.symbol)) {
      this.candleStore.set(candle.symbol, []);
    }

    const store = this.candleStore.get(candle.symbol);
    
    // Avoid duplicates
    const last = store[store.length - 1];
    if (last && last.timestamp === candle.timestamp) {
      store[store.length - 1] = candle; // Update existing
    } else {
      store.push(candle);
      if (store.length > 200) store.shift();
    }
  }

  analyze(symbol) {
    const candles = this.candleStore.get(symbol);
    if (!candles || candles.length < 50) return null;

    const closes = candles.map(c => c.close);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);

    // Calculate indicators
    const indicators = this.calculateIndicators(closes, highs, lows);
    if (!indicators) return null;

    // Run analysis
    return this.generateSignal(symbol, indicators, closes[closes.length - 1]);
  }

  calculateIndicators(closes, highs, lows) {
    try {
      const rsi = RSI.calculate({ values: closes, period: 14 });
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
      const bb = BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 });
      const atr = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
      const stoch = Stochastic.calculate({ high: highs, low: lows, close: closes, period: 14, signalPeriod: 3 });
      const adx = ADX.calculate({ high: highs, low: lows, close: closes, period: 14 });

      return {
        price: closes[closes.length - 1],
        rsi: rsi[rsi.length - 1],
        rsiPrev: rsi[rsi.length - 2],
        macd: macd[macd.length - 1],
        macdPrev: macd[macd.length - 2],
        ema9: ema9[ema9.length - 1],
        ema21: ema21[ema21.length - 1],
        ema50: ema50[ema50.length - 1],
        bb: bb[bb.length - 1],
        atr: atr[atr.length - 1],
        stoch: stoch[stoch.length - 1],
        stochPrev: stoch[stoch.length - 2],
        adx: adx[adx.length - 1],
        recentHighs: highs.slice(-20),
        recentLows: lows.slice(-20)
      };
    } catch (err) {
      console.error('Indicator calculation error:', err.message);
      return null;
    }
  }

  generateSignal(symbol, ind, currentPrice) {
    let buyScore = 0;
    let sellScore = 0;
    const reasons = [];

    // ═══════════════════════════════════════════════════════════
    // STRATEGY 1: TREND FOLLOWING
    // ═══════════════════════════════════════════════════════════

    // EMA Alignment (9 > 21 > 50 = bullish)
    if (ind.ema9 > ind.ema21 && ind.ema21 > ind.ema50) {
      buyScore += 20;
      reasons.push('EMA bullish alignment');
    } else if (ind.ema9 < ind.ema21 && ind.ema21 < ind.ema50) {
      sellScore += 20;
      reasons.push('EMA bearish alignment');
    }

    // MACD Crossover
    if (ind.macd && ind.macdPrev) {
      if (ind.macd.MACD > ind.macd.signal && ind.macdPrev.MACD <= ind.macdPrev.signal) {
        buyScore += 25;
        reasons.push('MACD bullish crossover');
      } else if (ind.macd.MACD < ind.macd.signal && ind.macdPrev.MACD >= ind.macdPrev.signal) {
        sellScore += 25;
        reasons.push('MACD bearish crossover');
      }
    }

    // ADX Trend Strength (only take signals in trending market)
    if (ind.adx && ind.adx.adx > 25) {
      const boost = Math.min((ind.adx.adx - 25) / 25, 0.5); // Max 50% boost
      if (ind.adx.pdi > ind.adx.mdi) {
        buyScore *= (1 + boost);
        reasons.push(`Strong uptrend (ADX: ${ind.adx.adx.toFixed(1)})`);
      } else {
        sellScore *= (1 + boost);
        reasons.push(`Strong downtrend (ADX: ${ind.adx.adx.toFixed(1)})`);
      }
    }

    // ═══════════════════════════════════════════════════════════
    // STRATEGY 2: MEAN REVERSION
    // ═══════════════════════════════════════════════════════════

    // RSI Oversold/Overbought
    if (ind.rsi < 30) {
      buyScore += 20;
      reasons.push(`RSI oversold (${ind.rsi.toFixed(1)})`);
    } else if (ind.rsi > 70) {
      sellScore += 20;
      reasons.push(`RSI overbought (${ind.rsi.toFixed(1)})`);
    }

    // Bollinger Band Touch
    if (ind.bb) {
      const percentB = (ind.price - ind.bb.lower) / (ind.bb.upper - ind.bb.lower);
      if (percentB < 0.05) {
        buyScore += 20;
        reasons.push('Price at lower BB');
      } else if (percentB > 0.95) {
        sellScore += 20;
        reasons.push('Price at upper BB');
      }
    }

    // Stochastic Crossover in Extreme Zones
    if (ind.stoch && ind.stochPrev) {
      if (ind.stoch.k < 20 && ind.stoch.k > ind.stoch.d && ind.stochPrev.k <= ind.stochPrev.d) {
        buyScore += 15;
        reasons.push('Stoch bullish crossover (oversold)');
      } else if (ind.stoch.k > 80 && ind.stoch.k < ind.stoch.d && ind.stochPrev.k >= ind.stochPrev.d) {
        sellScore += 15;
        reasons.push('Stoch bearish crossover (overbought)');
      }
    }

    // ═══════════════════════════════════════════════════════════
    // STRATEGY 3: BREAKOUT
    // ═══════════════════════════════════════════════════════════

    const recentHigh = Math.max(...ind.recentHighs.slice(0, -1));
    const recentLow = Math.min(...ind.recentLows.slice(0, -1));

    if (ind.price > recentHigh) {
      buyScore += 20;
      reasons.push('Breakout above recent high');
    } else if (ind.price < recentLow) {
      sellScore += 20;
      reasons.push('Breakdown below recent low');
    }

    // ═══════════════════════════════════════════════════════════
    // FINAL DECISION
    // ═══════════════════════════════════════════════════════════

    const netScore = buyScore - sellScore;
    
    let action = 'HOLD';
    let confidence = 0;

    if (netScore >= 40) {
      action = 'BUY';
      confidence = Math.min(Math.round(netScore), 100);
    } else if (netScore <= -40) {
      action = 'SELL';
      confidence = Math.min(Math.round(Math.abs(netScore)), 100);
    }

    // Calculate stop loss and take profit based on ATR
    const atrValue = ind.atr || currentPrice * 0.01;
    const stopLoss = action === 'BUY' 
      ? currentPrice - (atrValue * 2) 
      : currentPrice + (atrValue * 2);
    const takeProfit = action === 'BUY'
      ? currentPrice + (atrValue * 3)
      : currentPrice - (atrValue * 3);

    return {
      symbol,
      action,
      confidence,
      price: currentPrice,
      stopLoss,
      takeProfit,
      riskReward: 1.5,
      reasons: reasons.filter(r => {
        if (action === 'BUY') return !r.toLowerCase().includes('bearish') && !r.toLowerCase().includes('overbought');
        if (action === 'SELL') return !r.toLowerCase().includes('bullish') && !r.toLowerCase().includes('oversold');
        return true;
      }),
      indicators: {
        rsi: ind.rsi?.toFixed(2),
        macd: ind.macd?.histogram?.toFixed(5),
        adx: ind.adx?.adx?.toFixed(2),
        atr: atrValue?.toFixed(5)
      },
      timestamp: Date.now()
    };
  }
}