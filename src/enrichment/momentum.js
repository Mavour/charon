import { fetchJupiterChartWindow } from './jupiter.js';
import { fetchGmgnTokenInfo } from './gmgn.js';
import { now, firstPositiveNumber } from '../utils.js';
import { numSetting } from '../db/settings.js';

/**
 * Momentum Scorer - Phase 2
 * Analyzes volume, price, holder, and liquidity trends
 * to detect REAL organic momentum vs artificial pumps.
 */

// Cache momentum data to avoid repeated fetches
const momentumCache = new Map();

export function clearMomentumCache() {
  momentumCache.clear();
}

function cachedOrFetch(mint, key, ttlMs = 30_000) {
  const cacheKey = `${mint}:${key}`;
  const cached = momentumCache.get(cacheKey);
  if (cached && (now() - cached.at) < ttlMs) return cached.data;
  return null;
}

function setCache(mint, key, data, ttlMs = 30_000) {
  momentumCache.set(`${mint}:${key}`, { at: now(), data });
}

/**
 * Calculate candle metrics from Jupiter 5m candles
 */
function analyzeCandleMomentum(candles) {
  if (!candles || candles.length < 3) return null;
  const recent = candles.slice(-12); // last 1 hour (12 x 5m)
  const older = candles.slice(-24, -12); // 1-2 hours ago

  // Volume analysis
  const recentVol = recent.reduce((s, c) => s + Number(c.volume || 0), 0);
  const olderVol = older.length > 0 ? older.reduce((s, c) => s + Number(c.volume || 0), 0) : 0;
  const volumeChange = olderVol > 0 ? (recentVol - olderVol) / olderVol : 0;

  // Buy/sell pressure from candle bodies
  let bullishCandles = 0;
  let bearishCandles = 0;
  const momentumCandles = recent.map(c => {
    const open = Number(c.open || c.o || 0);
    const close = Number(c.close || c.c || 0);
    const high = Number(c.high || c.h || 0);
    const low = Number(c.low || c.l || 0);
    const body = close - open;
    const range = high - low || 1;
    const bodyRatio = body / range;
    if (body > 0) bullishCandles++;
    if (body < 0) bearishCandles++;
    return { open, close, high, low, volume: Number(c.volume || 0), bodyRatio };
  });

  // Price velocity (avg change per candle)
  const priceChanges = momentumCandles.slice(1).map((c, i) => {
    if (momentumCandles[i].close === 0) return 0;
    return (c.close - momentumCandles[i].close) / momentumCandles[i].close;
  });
  const avgPriceChange = priceChanges.length > 0
    ? priceChanges.reduce((s, v) => s + v, 0) / priceChanges.length
    : 0;

  // Price acceleration (2nd derivative)
  const accelerations = priceChanges.slice(1).map((c, i) => c - priceChanges[i]);
  const avgAcceleration = accelerations.length > 0
    ? accelerations.reduce((s, v) => s + v, 0) / accelerations.length
    : 0;

  // Volume distribution (is volume concentrated in one candle?)
  const avgVolume = recentVol / recent.length;
  const maxVolume = Math.max(...recent.map(c => Number(c.volume || 0)));
  const volumeConcentration = avgVolume > 0 ? maxVolume / avgVolume : 0;

  // Volatility
  const volatility = momentumCandles.reduce((s, c) => {
    const range = c.high - c.low;
    return s + (c.close > 0 ? range / c.close : 0);
  }, 0) / momentumCandles.length;

  return {
    recentVolume: recentVol,
    olderVolume: olderVol,
    volumeChangePct: volumeChange * 100,
    bullishCandles,
    bearishCandles,
    bullishRatio: recent.length > 0 ? bullishCandles / recent.length : 0,
    avgPriceChangePct: avgPriceChange * 100,
    avgAccelerationPct: avgAcceleration * 100,
    volumeConcentration,
    volatility,
    candleCount: candles.length,
  };
}

/**
 * Analyze holder growth from GMGN data
 */
function analyzeHolderGrowth(gmgn) {
  if (!gmgn) return null;
  const currentHolders = Number(gmgn.holder_count || gmgn.holders || 0);
  // If we have history data
  const history = gmgn.holder_history || [];
  if (history.length >= 2) {
    const recent = history.slice(-3);
    const growthRates = recent.slice(1).map((h, i) => {
      const prev = recent[i]?.count || recent[i];
      const cur = h?.count || h;
      if (!prev || prev <= 0) return 0;
      return (cur - prev) / prev;
    });
    const avgGrowth = growthRates.reduce((s, v) => s + v, 0) / growthRates.length;
    return {
      current: currentHolders,
      growthRateAvg: avgGrowth,
      growthDecelerating: avgGrowth < 0,
      historyPoints: history.length,
    };
  }
  // Single point: can't determine trend
  return {
    current: currentHolders,
    growthRateAvg: null,
    growthDecelerating: null,
    historyPoints: history.length || 0,
  };
}

/**
 * Calculate liquidity health score
 */
function calculateLiquidityHealth(gmgn, jupiterAsset) {
  const liquidity = firstPositiveNumber(
    gmgn?.liquidity,
    jupiterAsset?.liquidity,
    0
  );
  const mcap = firstPositiveNumber(
    gmgn?.market_cap ?? gmgn?.mcap,
    jupiterAsset?.mcap ?? jupiterAsset?.fdv,
    0
  );
  if (!liquidity || !mcap || mcap <= 0) return null;
  const ratio = liquidity / mcap;
  // Healthy: liquidity should be 10-30% of mcap
  // Too low ( < 5%): thin liquidity, easy to manipulate
  // Too high ( > 50%): suspicious or data error
  let score = 50;
  if (ratio >= 0.10 && ratio <= 0.30) score += 30;
  else if (ratio >= 0.05 && ratio < 0.10) score += 10;
  else if (ratio >= 0.30 && ratio <= 0.50) score += 10;
  else if (ratio < 0.05) score -= 40; // very thin
  else if (ratio > 0.50) score -= 20; // suspiciously high
  return {
    liquidityUsd: liquidity,
    mcapUsd: mcap,
    liquidityMcapRatio: ratio,
    score: Math.max(0, Math.min(100, score)),
    label: ratio < 0.05 ? 'thin' : ratio > 0.50 ? 'suspicious' : ratio < 0.10 ? 'low' : 'healthy',
  };
}

/**
 * Detect volume spike patterns
 * Returns true if latest volume is 3x+ average but doesn't sustain
 */
function detectVolumePump(momentum) {
  if (!momentum || momentum.candleCount < 6) return false;
  // Volume spike followed by decay in last 3 candles
  const volChange = momentum.volumeChangePct;
  if (volChange > 200) {
    // Spiked > 3x, but if acceleration is negative = pump and dump
    if (momentum.avgAccelerationPct < -5) return true;
  }
  return false;
}

/**
 * Main momentum analysis function
 */
export async function analyzeTokenMomentum(mint, { gmgn = null, jupiterAsset = null } = {}) {
  const cacheKey = 'momentum';
  const cached = cachedOrFetch(mint, cacheKey, 30_000);
  if (cached) return cached;

  // Fetch chart data
  let chartData;
  try {
    chartData = await fetchJupiterChartWindow(mint, '5_MINUTE', 24, 'momentum_2h_5m');
  } catch {
    chartData = { available: false, candles: [] };
  }

  const candleMomentum = chartData.available
    ? analyzeCandleMomentum(chartData.candles)
    : null;

  const holderGrowth = analyzeHolderGrowth(gmgn);
  const liquidityHealth = calculateLiquidityHealth(gmgn, jupiterAsset);

  // Composite momentum score (0-100)
  let score = 50; // neutral starting point
  let factors = [];

  // Price momentum
  if (candleMomentum) {
    const pc = candleMomentum;
    // Volume trend
    if (pc.volumeChangePct > 100) { score += 15; factors.push('volume_surge'); }
    else if (pc.volumeChangePct >= 50) { score += 10; factors.push('volume_up'); }
    else if (pc.volumeChangePct < -50) { score -= 15; factors.push('volume_crash'); }
    else if (pc.volumeChangePct < -20) { score -= 8; factors.push('volume_decline'); }

    // Candle bias
    if (pc.bullishRatio >= 0.65) { score += 12; factors.push('strong_bullish'); }
    else if (pc.bullishRatio >= 0.55) { score += 6; factors.push('moderate_bullish'); }
    else if (pc.bullishRatio <= 0.35) { score -= 12; factors.push('bearish'); }

    // Volatility (too high = unstable)
    if (pc.volatility > 0.15) { score -= 8; factors.push('high_volatility'); }
    else if (pc.volatility < 0.02) { score -= 5; factors.push('low_volatility'); }

    // Price acceleration
    if (pc.avgAccelerationPct > 5) { score += 10; factors.push('accelerating'); }
    else if (pc.avgAccelerationPct < -5) { score -= 10; factors.push('decelerating'); }

    // Volume pump detection (fake pump)
    if (detectVolumePump(pc)) { score -= 20; factors.push('volume_pump_dump'); }
  }

  // Holder growth
  if (holderGrowth) {
    if (holderGrowth.growthRateAvg !== null) {
      const gr = holderGrowth.growthRateAvg * 100; // convert to pct
      if (gr > 50) { score += 15; factors.push('holder_surge'); }
      else if (gr > 20) { score += 8; factors.push('holder_growth'); }
      else if (gr < -10) { score -= 15; factors.push('holders_leaving'); }
      else if (gr < 0) { score -= 5; factors.push('holder_decline'); }
    }
    if (holderGrowth.current < 50) { score -= 15; factors.push('very_few_holders'); }
    else if (holderGrowth.current < 100) { score -= 8; factors.push('few_holders'); }
    else if (holderGrowth.current >= 500) { score += 5; factors.push('decent_holders'); }
  }

  // Liquidity health
  if (liquidityHealth) {
    score += (liquidityHealth.score - 50) * 0.3; // +/- up to 15 points
    factors.push(`liquidity_${liquidityHealth.label}`);
  }

  // Clamp and classify
  const finalScore = Math.max(0, Math.min(100, Math.round(score)));
  const classification = finalScore >= 70 ? 'strong' : finalScore >= 50 ? 'moderate' : finalScore >= 30 ? 'weak' : 'dead';
  const isOrganic = !factors.includes('volume_pump_dump') && factors.includes('volume_up') && pc?.bullishRatio >= 0.55;

  const result = {
    score: finalScore,
    classification,
    isOrganic,
    factors: [...new Set(factors)],
    candleMomentum: candleMomentum ? {
      ...candleMomentum,
      volumePumpDump: detectVolumePump(candleMomentum),
    } : null,
    holderGrowth,
    liquidityHealth,
    timestamp: now(),
  };

  setCache(mint, cacheKey, result);
  return result;
}

/**
 * Quick momentum pre-filter for budget skipping
 */
export function quickMomentumFilter(momentum, strat) {
  if (!momentum) return { passed: true, reason: 'no_data' };

  const fails = [];

  // Volume crash detection
  const volumeDropThreshold = strat.momentum_volume_drop_pct ?? 60;
  if (momentum.candleMomentum?.volumeChangePct < -volumeDropThreshold) {
    fails.push(`volume_drop: ${momentum.candleMomentum.volumeChangePct.toFixed(0)}%`);
  }

  // Pump and dump detection (already caught by score but explicit check)
  if (momentum.candleMomentum?.volumePumpDump) {
    fails.push('volume_pump_dump_detected');
  }

  // Dead token detection
  if (momentum.classification === 'dead' && momentum.score < 20) {
    fails.push('momentum_dead');
  }

  // Very weak momentum + no organic growth
  if (momentum.score < 25 && !momentum.isOrganic) {
    fails.push(`momentum_score: ${momentum.score} too low`);
  }

  // Holder exodus
  if (momentum.holderGrowth?.growthRateAvg < -0.2) { // >20% holders left
    fails.push('holder_exodus');
  }

  return { passed: fails.length === 0, failures: fails };
}
