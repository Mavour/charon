import axios from 'axios';
import { Connection, PublicKey } from '@solana/web3.js';
import { SOLANA_RPC_URL, JSON_HEADERS } from '../config.js';
import { now, sleep } from '../utils.js';
import { numSetting } from '../db/settings.js';

let connection = null;
function getConnection() {
  if (!connection) connection = new Connection(SOLANA_RPC_URL, 'confirmed');
  return connection;
}

const TRANSFER_CACHE = new Map();
const BUNDLE_SCORE_CACHE = new Map();

/**
 * Batch analyze token transfers to detect bundle/sniper patterns
 * Similar to gmgn trending bundler_rate but from on-chain data
 */
export async function fetchTokenTransfers(mint, { limit = 100 } = {}) {
  const cacheKey = `${mint}:transfers`;
  const cached = TRANSFER_CACHE.get(cacheKey);
  if (cached && (now() - cached.at) < 2 * 60 * 1000) return cached.data;
  try {
    const conn = getConnection();
    const mintPubkey = new PublicKey(mint);
    // Get transfer signatures (memo program or transferChecked)
    const sigs = await conn.getSignaturesForAddress(mintPubkey, { limit: limit * 2 }, 'confirmed');
    if (!sigs.length) return [];
    const result = [];
    for (const sig of sigs) {
      result.push({
        signature: sig.signature,
        timestamp: (sig.blockTime || 0) * 1000,
        slot: sig.slot,
        err: sig.err,
      });
    }
    TRANSFER_CACHE.set(cacheKey, { at: now(), data: result });
    return result;
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Analyze transaction timing to detect bundles
 * Bundles = many txns in same slot or within same few seconds
 */
export function analyzeBundlePatterns(transfers) {
  if (!Array.isArray(transfers) || transfers.length < 5) {
    return { bundleRate: 0, sniperRate: 0, pattern: 'insufficient_data' };
  }
  const sorted = [...transfers].sort((a, b) => a.timestamp - b.timestamp);
  const firstTs = sorted[0].timestamp;
  const totalMs = sorted[sorted.length - 1].timestamp - firstTs;
  if (totalMs <= 0) return { bundleRate: 0, sniperRate: 0, pattern: 'single_burst' };

  // Group by slot
  const slotGroups = new Map();
  for (const t of sorted) {
    const slot = t.slot || 0;
    if (!slotGroups.has(slot)) slotGroups.set(slot, []);
    slotGroups.get(slot).push(t);
  }

  // Group by 5-second windows
  const windowMs = 5000;
  const windows = new Map();
  for (const t of sorted) {
    const bucket = Math.floor((t.timestamp - firstTs) / windowMs);
    if (!windows.has(bucket)) windows.set(bucket, []);
    windows.get(bucket).push(t);
  }

  // Count slots with >=5 txns (bundle indicator)
  let bundledSlots = 0;
  let maxSlotTxns = 0;
  for (const [slot, txns] of slotGroups) {
    if (txns.length >= 5) bundledSlots++;
    maxSlotTxns = Math.max(maxSlotTxns, txns.length);
  }

  // Count windows with >=10 txns
  let burstWindows = 0;
  let maxWindowTxns = 0;
  for (const [bucket, txns] of windows) {
    if (txns.length >= 10) burstWindows++;
    maxWindowTxns = Math.max(maxWindowTxns, txns.length);
  }

  const bundleRate = sorted.length > 0
    ? Math.min(1, (bundledSlots * 5 + burstWindows * 3) / sorted.length)
    : 0;

  // Sniper rate: first 60 seconds ratio
  const firstMinute = sorted.filter(t => t.timestamp - firstTs <= 60_000).length;
  const sniperRate = sorted.length > 0
    ? Math.min(1, firstMinute / Math.min(sorted.length, 50))
    : 0;

  return {
    totalTxns: sorted.length,
    bundledSlots,
    burstWindows,
    maxSlotTxns,
    maxWindowTxns,
    bundleRate: Math.round(bundleRate * 1000) / 1000,
    sniperRate: Math.round(sniperRate * 1000) / 1000,
    firstMinuteTxns: firstMinute,
    avgTxnsPerSlot: sorted.length / slotGroups.size,
    pattern: bundleRate > 0.3 ? 'heavy_bundle' : bundleRate > 0.1 ? 'moderate_bundle' : sniperRate > 0.5 ? 'sniper_heavy' : 'organic',
  };
}

/**
 * Detect if holders entered in clusters (many in same slot = probably same operator)
 */
export function detectHolderClustering(holders, slotMap = {}) {
  if (!holders?.holders?.length) return null;
  const holderList = holders.holders;
  // If we have slot data, use it. Otherwise infer from creation timing
  // This is a simplified version - full version needs RPC call per holder
  const newWallets = holderList.filter(h => !h.tags?.length || h.tags.includes('new'));
  const newPct = holderList.length > 0 ? newWallets.length / holderList.length : 0;
  return {
    holderCount: holderList.length,
    newWalletPct: Math.round(newPct * 1000) / 1000,
    clusteredEntries: null, // Would need deeper RPC analysis
    pattern: newPct > 0.7 ? 'mostly_new' : newPct > 0.4 ? 'mixed' : 'established',
  };
}

/**
 * Main bundle score calculator
 * Combines trending data (from GMGN), transfer analysis (RPC), and holder clustering
 */
export async function calculateBundleScore(mint, trendingToken = null, holders = null) {
  const cacheKey = `${mint}:bundle`;
  const cached = BUNDLE_SCORE_CACHE.get(cacheKey);
  if (cached && (now() - cached.at) < 60_000) return cached.data;

  // Start with GMGN trending bundler_rate if available
  const gmgnBundlerRate = Number(trendingToken?.bundler_rate ?? 0);

  // Get on-chain transfer data
  const transfers = await fetchTokenTransfers(mint, { limit: 100 });
  const transferAnalysis = Array.isArray(transfers)
    ? analyzeBundlePatterns(transfers)
    : { bundleRate: 0, sniperRate: 0, pattern: 'error', error: transfers.error };

  // Holder clustering
  const holderClustering = holders ? detectHolderClustering(holders) : null;

  // Combined scoring (0-100, higher = more bundled/snipered)
  let score = 0;
  let factors = [];

  // GMGN bundler rate (external signal)
  if (Number.isFinite(gmgnBundlerRate) && gmgnBundlerRate > 0) {
    score += gmgnBundlerRate * 40; // max 40 points
    if (gmgnBundlerRate > 0.5) factors.push('high_gmgn_bundler_rate');
    else if (gmgnBundlerRate > 0.2) factors.push('moderate_gmgn_bundler_rate');
  }

  // On-chain bundle rate
  if (transferAnalysis.bundleRate > 0.3) {
    score += 30;
    factors.push('onchain_slots_heavy');
  } else if (transferAnalysis.bundleRate > 0.1) {
    score += 15;
    factors.push('onchain_slots_moderate');
  }

  // Sniper rate
  if (transferAnalysis.sniperRate > 0.7) {
    score += 20;
    factors.push('first_minute_sniper_heavy');
  } else if (transferAnalysis.sniperRate > 0.4) {
    score += 10;
    factors.push('first_minute_active');
  }

  // Max slot txns (single slot with many txns = definitely bundled)
  if (transferAnalysis.maxSlotTxns >= 20) {
    score += 10;
    factors.push('extreme_slot_congestion');
  } else if (transferAnalysis.maxSlotTxns >= 10) {
    score += 5;
    factors.push('high_slot_congestion');
  }

  // New wallet clustering
  if (holderClustering) {
    if (holderClustering.newWalletPct > 0.8) {
      score += 10;
      factors.push('mostly_new_wallets');
    } else if (holderClustering.newWalletPct < 0.2 && holderClustering.holderCount > 100) {
      score -= 10;
      factors.push('established_holders');
    }
  }

  const finalScore = Math.min(100, Math.round(score));
  const riskLevel = finalScore >= 60 ? 'high' : finalScore >= 35 ? 'moderate' : finalScore >= 15 ? 'low' : 'minimal';

  const result = {
    score: finalScore,
    riskLevel,
    factors: [...new Set(factors)],
    isBundled: finalScore >= 60,
    isSniperHeavy: transferAnalysis.sniperRate >= 0.5,
    gmgnBundlerRate,
    transferAnalysis,
    holderClustering,
    timestamp: now(),
  };

  BUNDLE_SCORE_CACHE.set(cacheKey, { at: now(), data: result });
  return result;
}

/**
 * Quick bundle filter for pre-screening
 * Returns pass/fail with failures
 */
export function bundleFilterResult(bundle, strat) {
  if (!bundle) return { passed: true, reason: 'no_data' };
  const failures = [];

  const maxBundleScore = numSetting('max_bundle_score', 60);
  if (bundle.score > maxBundleScore) {
    failures.push(`bundle_score: ${bundle.score} > ${maxBundleScore} (${bundle.riskLevel})`);
  }

  // For very new tokens (< 30 min), be stricter about snipers
  const isVeryNew = bundle.transferAnalysis?.firstMinuteTxns > 30;
  if (isVeryNew && bundle.isSniperHeavy) {
    failures.push('fresh_token_with_sniper_flood');
  }

  // If GMGN reports high bundler rate AND on-chain confirms
  if (bundle.gmgnBundlerRate > 0.5 && bundle.transferAnalysis?.bundleRate > 0.2) {
    failures.push('confirmed_bundle_attack');
  }

  return { passed: failures.length === 0, failures };
}

/**
 * Detect if dev is also buying up supply (insider accumulation)
 * By checking if large % of supply moved in first few slots
 */
export async function detectInsiderAccumulation(mint, holders) {
  if (!holders?.top20?.length) return null;
  const topHoldings = holders.top20.slice(0, 5);
  const totalTop5 = topHoldings.reduce((s, h) => s + Number(h.percent || 0), 0);
  if (totalTop5 > 50) {
    return {
      risk: true,
      top5Percent: totalTop5,
      reason: 'extreme_concentration',
    };
  }
  if (totalTop5 > 35) {
    return {
      risk: true,
      top5Percent: totalTop5,
      reason: 'high_concentration',
    };
  }
  return {
    risk: false,
    top5Percent: totalTop5,
    reason: 'acceptable',
  };
}
