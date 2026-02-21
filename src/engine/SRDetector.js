// ═══════════════════════════════════════════════════════════════════
// SR DETECTOR v2 — Improved Support & Resistance Detection
//
// Problems with old findSR():
// 1. Too many levels — pivot on every candle = noise
// 2. No clustering — 10 resistance levels within 2 pips of each other
// 3. No strength — all levels treated equally
// 4. No recency bias — a level from 50 candles ago = same weight as recent
//
// This version:
// 1. Proper swing high/low detection (5-candle confirmation)
// 2. Clusters nearby levels within 0.5 ATR tolerance
// 3. Scores levels by: touch count + recency + bounce strength
// 4. Returns top 3 support and top 3 resistance levels with strength scores
// ═══════════════════════════════════════════════════════════════════

export class SRDetector {

    // ── MAIN ENTRY POINT ──
    // Returns: { support, resistance, allLevels, nearestSupport, nearestResistance }
    findSR(closes, highs, lows, atr) {
      const price = closes[closes.length - 1];
      const swings = this.detectSwings(highs, lows, closes);
      const clustered = this.clusterLevels(swings, atr);
      const scored = this.scoreLevels(clustered, closes, highs, lows, atr);
  
      const supports = scored
        .filter(l => l.price < price)
        .sort((a, b) => b.price - a.price); // Nearest first
  
      const resistances = scored
        .filter(l => l.price > price)
        .sort((a, b) => a.price - b.price); // Nearest first
  
      return {
        // Primary levels (for signal engine compatibility)
        support: supports[0]?.price || Math.min(...lows.slice(-20)),
        resistance: resistances[0]?.price || Math.max(...highs.slice(-20)),
  
        // Extended levels
        supports: supports.slice(0, 3),
        resistances: resistances.slice(0, 3),
  
        // Nearest strong levels with strength scores
        nearestSupport: supports[0] || null,
        nearestResistance: resistances[0] || null,
  
        // All levels for debugging
        allLevels: scored
      };
    }
  
    // ── STEP 1: SWING HIGH/LOW DETECTION ──
    // A swing high = candle[i].high is highest of 5-candle window (2 left, 2 right)
    // A swing low  = candle[i].low is lowest of 5-candle window
    detectSwings(highs, lows, closes) {
      const swings = [];
      const lookback = Math.min(100, highs.length); // Look at last 100 candles
      const start = highs.length - lookback;
      const confirmBars = 2; // How many bars each side must confirm
  
      for (let i = start + confirmBars; i < highs.length - confirmBars; i++) {
        const isSwingHigh = this._isSwingHigh(highs, i, confirmBars);
        const isSwingLow = this._isSwingLow(lows, i, confirmBars);
  
        if (isSwingHigh) {
          swings.push({
            price: highs[i],
            type: 'RESISTANCE',
            index: i,
            age: highs.length - i, // How many candles ago
            raw: true
          });
        }
  
        if (isSwingLow) {
          swings.push({
            price: lows[i],
            type: 'SUPPORT',
            index: i,
            age: highs.length - i,
            raw: true
          });
        }
      }
  
      return swings;
    }
  
    _isSwingHigh(highs, i, bars) {
      for (let j = 1; j <= bars; j++) {
        if (highs[i] <= highs[i - j] || highs[i] <= highs[i + j]) return false;
      }
      return true;
    }
  
    _isSwingLow(lows, i, bars) {
      for (let j = 1; j <= bars; j++) {
        if (lows[i] >= lows[i - j] || lows[i] >= lows[i + j]) return false;
      }
      return true;
    }
  
    // ── STEP 2: CLUSTER NEARBY LEVELS ──
    // Group levels within 0.5 ATR of each other into a single zone
    // The zone price = weighted average of all levels in the cluster
    clusterLevels(swings, atr) {
      if (swings.length === 0) return [];
  
      const tolerance = atr * 0.5; // Cluster radius
      const clusters = [];
  
      // Sort by price
      const sorted = [...swings].sort((a, b) => a.price - b.price);
  
      let currentCluster = [sorted[0]];
  
      for (let i = 1; i < sorted.length; i++) {
        const swing = sorted[i];
        const clusterCenter = currentCluster.reduce((s, c) => s + c.price, 0) / currentCluster.length;
  
        if (Math.abs(swing.price - clusterCenter) <= tolerance) {
          // Add to current cluster
          currentCluster.push(swing);
        } else {
          // Save cluster, start new one
          clusters.push(this._buildCluster(currentCluster));
          currentCluster = [swing];
        }
      }
  
      // Don't forget last cluster
      if (currentCluster.length > 0) {
        clusters.push(this._buildCluster(currentCluster));
      }
  
      return clusters;
    }
  
    _buildCluster(swings) {
      const avgPrice = swings.reduce((s, c) => s + c.price, 0) / swings.length;
      const minAge = Math.min(...swings.map(s => s.age));
      const touchCount = swings.length;
  
      // Type = whichever type appears more
      const resistanceCount = swings.filter(s => s.type === 'RESISTANCE').length;
      const type = resistanceCount >= swings.length / 2 ? 'RESISTANCE' : 'SUPPORT';
  
      return {
        price: avgPrice,
        type,
        touchCount,
        minAge, // Most recent touch (in candles)
        swings,
        strength: 0 // Will be calculated in scoreLevels
      };
    }
  
    // ── STEP 3: SCORE LEVELS ──
    // Score = touchCount × recencyBonus × bounceStrength
    scoreLevels(clusters, closes, highs, lows, atr) {
      return clusters.map(cluster => {
        let score = 0;
  
        // Touch count score (more touches = stronger level)
        score += cluster.touchCount * 10;
  
        // Recency bonus (levels touched recently are more relevant)
        // Age 0-10 candles: +20 pts, 10-30: +10, 30+: +0
        if (cluster.minAge <= 10) score += 20;
        else if (cluster.minAge <= 30) score += 10;
  
        // Bounce strength — did price respect this level?
        // Check if close bounced away from the level (not through it)
        const bounces = this._countBounces(cluster.price, closes, highs, lows, atr);
        score += bounces * 8;
  
        // Penalty: if price has traded through this level recently, it's weaker
        const breaches = this._countBreaches(cluster.price, closes, atr);
        score -= breaches * 5;
  
        // Normalize to 0-100
        cluster.strength = Math.min(100, Math.max(0, score));
        return cluster;
      }).sort((a, b) => b.strength - a.strength);
    }
  
    // Count how many times price bounced off a level
    _countBounces(levelPrice, closes, highs, lows, atr) {
      let bounces = 0;
      const tolerance = atr * 0.3;
  
      for (let i = 5; i < closes.length - 1; i++) {
        const touchedFromAbove = lows[i] <= levelPrice + tolerance && lows[i] >= levelPrice - tolerance && closes[i] > levelPrice;
        const touchedFromBelow = highs[i] >= levelPrice - tolerance && highs[i] <= levelPrice + tolerance && closes[i] < levelPrice;
  
        if (touchedFromAbove || touchedFromBelow) bounces++;
      }
  
      return bounces;
    }
  
    // Count how many times price closed through a level (weakens it)
    _countBreaches(levelPrice, closes, atr) {
      let breaches = 0;
      const tolerance = atr * 0.1;
  
      for (let i = 1; i < closes.length; i++) {
        const crossedUp = closes[i - 1] < levelPrice - tolerance && closes[i] > levelPrice + tolerance;
        const crossedDown = closes[i - 1] > levelPrice + tolerance && closes[i] < levelPrice - tolerance;
        if (crossedUp || crossedDown) breaches++;
      }
  
      return breaches;
    }
  
    // ── UTILITY: Check if price is near a level ──
    // Returns: { near: bool, level: obj, distance: number, side: 'ABOVE'|'BELOW' }
    isNearLevel(price, srResult, atr, multiplier = 1.0) {
      const threshold = atr * multiplier;
      const allLevels = [...(srResult.supports || []), ...(srResult.resistances || [])];
  
      for (const level of allLevels) {
        const dist = Math.abs(price - level.price);
        if (dist < threshold) {
          return {
            near: true,
            level,
            distance: dist,
            side: price > level.price ? 'ABOVE' : 'BELOW'
          };
        }
      }
  
      return { near: false };
    }
  
    // ── FORMAT for Discord/logging ──
    formatLevels(srResult) {
      const fmt = (l) => `${l.price.toFixed(2)} (str:${l.strength.toFixed(0)} touches:${l.touchCount})`;
      return {
        supports: (srResult.supports || []).map(fmt).join(' | ') || 'None',
        resistances: (srResult.resistances || []).map(fmt).join(' | ') || 'None'
      };
    }
  }