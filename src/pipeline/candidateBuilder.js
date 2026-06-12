import { now, firstPositiveNumber, marketCapFromGmgn, tokenPriceFromGmgn, lamToSol, withTimeout } from '../utils.js';
import { activeStrategy } from '../db/settings.js';
import { fetchGmgnTokenInfo } from '../enrichment/gmgn.js';
import { fetchJupiterAsset, fetchJupiterHolders, fetchJupiterChartContext } from '../enrichment/jupiter.js';
import { fetchSavedWalletExposure } from '../enrichment/wallets.js';
import { fetchTwitterNarrative } from '../enrichment/twitter.js';
import { fetchRugcheckReport, isRugcheckSafe, extractSecurityFromRugcheck } from '../enrichment/rugcheck.js';
import { runTokenSecurityCheck } from '../enrichment/security.js';
import { fetchDevWalletForToken, analyzeDevWallet } from '../enrichment/devWallet.js';
import { analyzeTokenMomentum, quickMomentumFilter } from '../enrichment/momentum.js';
import { calculateBundleScore, bundleFilterResult } from '../enrichment/bundleDetector.js';
import { gmgnLink } from '../format.js';
import { db } from '../db/connection.js';
import { safeJson } from '../utils.js';

export function buildFeeSnapshot(fee, signature) {
  const recipients = fee.shareholders.map(holder => ({
    address: holder.pubkey,
    bps: holder.bps,
    percent: holder.bps / 100,
  }));
  return {
    mint: fee.mint,
    signature,
    distributedSol: lamToSol(fee.distributed),
    uniqueRecipientCount: new Set(recipients.map(recipient => recipient.address)).size,
    maxRecipientPercent: Math.max(0, ...recipients.map(recipient => Number(recipient.percent || 0))),
    recipients,
  };
}

function firstTimestampMs(...values) {
  for (const value of values) {
    const number = Number(value);
    const parsedDate = Number.isFinite(number) ? null : Date.parse(String(value || ''));
    const timestamp = Number.isFinite(number) ? number : parsedDate;
    if (!Number.isFinite(timestamp) || timestamp <= 0) continue;
    return timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1000;
  }
  return null;
}

function tokenAgeMsFromSources(gmgn, jupiterAsset, graduatedCoin, trendingToken) {
  const createdAtMs = firstTimestampMs(
    gmgn?.created_at,
    gmgn?.createdAt,
    gmgn?.creation_timestamp,
    gmgn?.created_timestamp,
    gmgn?.launch_time,
    gmgn?.open_timestamp,
    jupiterAsset?.createdAt,
    jupiterAsset?.created_at,
    jupiterAsset?.firstPool?.createdAt,
    graduatedCoin?.createdAt,
    graduatedCoin?.created_at,
    graduatedCoin?.created_timestamp,
    trendingToken?.created_at,
    trendingToken?.createdAt,
    trendingToken?.open_timestamp,
  );
  return createdAtMs ? Math.max(0, now() - createdAtMs) : null;
}

function buildSocialCheck(token, twitterNarrative) {
  const twitter = String(token.twitter || '').trim();
  const hasTwitter = Boolean(twitter || twitterNarrative?.url);
  const hasSocial = hasTwitter || Boolean(token.website || token.telegram);
  const tweetCreatedMs = firstTimestampMs(
    twitterNarrative?.metrics?.createdTimestamp,
    twitterNarrative?.metrics?.createdAt,
  );
  return {
    hasSocial,
    hasTwitter,
    twitter,
    website: token.website || '',
    telegram: token.telegram || '',
    tweetAgeHours: tweetCreatedMs ? (now() - tweetCreatedMs) / 3_600_000 : null,
    twitterNarrativeFetched: Boolean(twitterNarrative),
  };
}

function buildSmartWalletSignal(savedWalletExposure, chart) {
  const athDist = Number(chart?.distanceFromAthPercent);
  const qualifiedCount = Number(savedWalletExposure?.qualifiedCount ?? savedWalletExposure?.holderCount ?? 0);
  return {
    holderCount: Number(savedWalletExposure?.holderCount ?? 0),
    qualifiedCount,
    qualifiedWallets: savedWalletExposure?.qualifiedWallets || [],
    enteredAfterDip: Number.isFinite(athDist) ? athDist <= -20 : null,
    distanceFromAthPercent: Number.isFinite(athDist) ? athDist : null,
  };
}

function buildFeeDistribution(mint, feeClaim, liquidityUsd) {
  const since = now() - 30 * 60 * 1000;
  const events = db.prepare(`
    SELECT at_ms, payload_json
    FROM signal_events
    WHERE mint = ? AND kind = 'fee_claim' AND at_ms >= ?
    ORDER BY at_ms DESC
  `).all(mint, since);
  const snapshots = events
    .map(event => safeJson(event.payload_json, null)?.fee)
    .filter(Boolean);
  if (feeClaim && !snapshots.some(snapshot => snapshot.signature === feeClaim.signature)) snapshots.unshift(feeClaim);
  const recipients = new Set();
  let totalDistributedSol = 0;
  let maxClaimSol = 0;
  for (const snapshot of snapshots) {
    const distributedSol = Number(snapshot.distributedSol || 0);
    if (Number.isFinite(distributedSol)) {
      totalDistributedSol += distributedSol;
      maxClaimSol = Math.max(maxClaimSol, distributedSol);
    }
    for (const recipient of snapshot.recipients || []) {
      if (recipient.address) recipients.add(recipient.address);
    }
  }
  const currentRecipients = feeClaim?.recipients || [];
  const uniqueRecipientCount = new Set(currentRecipients.map(recipient => recipient.address)).size;
  return {
    currentUniqueRecipients: uniqueRecipientCount,
    currentMaxRecipientPercent: Math.max(0, ...currentRecipients.map(recipient => Number(recipient.percent || 0))),
    claims30m: snapshots.length,
    totalDistributedSol30m: totalDistributedSol,
    uniqueRecipients30m: recipients.size,
    maxSingleClaimShare30m: totalDistributedSol > 0 ? maxClaimSol / totalDistributedSol : null,
    feeTvlRatio: Number(liquidityUsd) > 0 ? totalDistributedSol / Number(liquidityUsd) : null,
    organicRecipientDistribution: uniqueRecipientCount >= 5 || recipients.size >= 5,
    consistent30m: snapshots.length >= 2 && totalDistributedSol > 0 && (maxClaimSol / totalDistributedSol) < 0.85,
  };
}

export function signalLabel(signals = {}) {
  return [
    signals.hasFeeClaim ? 'fees' : null,
    signals.hasGraduated ? 'graduated' : null,
    signals.hasTrending ? 'trending' : null,
  ].filter(Boolean).join(' + ') || signals.route || 'unknown';
}

export function filterCandidate(candidate) {
  const strat = activeStrategy();
  const failures = [];
  const mcap = candidate.metrics.marketCapUsd;
  const totalFees = candidate.metrics.gmgnTotalFeesSol;
  const gradVolume = candidate.metrics.graduatedVolumeUsd;
  const maxHolder = candidate.holders.maxHolderPercent;
  const savedCount = candidate.savedWalletExposure.holderCount;
  const smartCount = Number(candidate.smartWalletSignal?.qualifiedCount ?? candidate.savedWalletExposure?.qualifiedCount ?? savedCount);
  const feeSol = candidate.feeClaim?.distributedSol;
  const holderCount = Number(candidate.metrics.holderCount || 0);
  const top20Percent = Number(candidate.holders?.top20Percent);
  const trendingVolume = Number(candidate.trending?.volume ?? 0);
  const trendingSwaps = Number(candidate.trending?.swaps ?? 0);
  const rugRatio = Number(candidate.trending?.rug_ratio ?? 0);
  const bundlerRate = Number(candidate.trending?.bundler_rate ?? 0);
  const tokenAgeMs = candidate.metrics.tokenAgeMs == null ? null : Number(candidate.metrics.tokenAgeMs);

  // Fee claim check
  if (candidate.feeClaim) {
    const minFee = strat.min_fee_claim_sol ?? 0.5;
    if (minFee > 0 && feeSol < minFee) {
      failures.push(`fee claim: ${feeSol} SOL < min ${minFee} SOL`);
    }
    const minFeeRecipients = strat.min_fee_unique_recipients ?? 0;
    const recipientCount = Number(candidate.feeDistribution?.currentUniqueRecipients ?? candidate.feeClaim?.uniqueRecipientCount ?? 0);
    if (minFeeRecipients > 0 && recipientCount < minFeeRecipients) {
      failures.push(`fee recipients: ${recipientCount} < ${minFeeRecipients}`);
    }
    const minFeeClaims30m = strat.min_fee_claims_30m ?? 0;
    const claims30m = Number(candidate.feeDistribution?.claims30m ?? 0);
    if (minFeeClaims30m > 0 && claims30m < minFeeClaims30m) {
      failures.push(`fee consistency: ${claims30m} claims/30m < ${minFeeClaims30m}`);
    }
    if (strat.reject_concentrated_fee_recipients && recipientCount > 0 && recipientCount <= 2) {
      failures.push(`fee recipients: ${recipientCount} looks concentrated`);
    }
  } else if (strat.require_fee_claim) {
    failures.push('fee claim: missing (required by strategy)');
  }

  // Market cap checks
  if (strat.min_mcap_usd > 0 && (!Number.isFinite(mcap) || mcap < strat.min_mcap_usd)) {
    failures.push(`market cap min: ${mcap} < ${strat.min_mcap_usd}`);
  }
  if (strat.max_mcap_usd > 0 && Number.isFinite(mcap) && mcap > strat.max_mcap_usd) {
    failures.push(`market cap max: ${mcap} > ${strat.max_mcap_usd}`);
  }

  // GMGN fees — only enforce when GMGN data is available; Jupiter has no equivalent
  if (strat.min_gmgn_total_fee_sol > 0 && candidate.gmgn !== null && totalFees < strat.min_gmgn_total_fee_sol) {
    failures.push(`GMGN total fees: ${totalFees} < ${strat.min_gmgn_total_fee_sol}`);
  }

  // Graduated volume — only enforce when the token actually has graduated data
  if (strat.min_graduated_volume_usd > 0 && candidate.graduation && gradVolume < strat.min_graduated_volume_usd) {
    failures.push(`graduated volume: ${gradVolume} < ${strat.min_graduated_volume_usd}`);
  }

  // Holder count
  if (strat.min_holders > 0 && holderCount < strat.min_holders) {
    failures.push(`holders: ${holderCount} < ${strat.min_holders}`);
  }
  if (strat.max_holders > 0 && holderCount > strat.max_holders) {
    failures.push(`holders: ${holderCount} > ${strat.max_holders}`);
  }

  // Top holder concentration
  if (strat.max_top20_holder_percent < 100 && Number.isFinite(top20Percent) && top20Percent > strat.max_top20_holder_percent) {
    failures.push(`top 20 holders: ${top20Percent.toFixed(1)}% > ${strat.max_top20_holder_percent}%`);
  } else if (strat.max_top20_holder_percent < 100 && Number.isFinite(maxHolder) && maxHolder > strat.max_top20_holder_percent) {
    failures.push(`max holder: ${maxHolder}% > ${strat.max_top20_holder_percent}%`);
  }
  if (Number.isFinite(top20Percent) && top20Percent > 50) {
    // SOFT FLAG — not a hard reject. Common in memecoins.
    // LLM will evaluate this in context.
  }

  // Saved wallet holders
  if (strat.min_saved_wallet_holders > 0 && savedCount < strat.min_saved_wallet_holders) {
    failures.push(`saved wallet holders: ${savedCount} < ${strat.min_saved_wallet_holders}`);
  }
  if (strat.min_smart_wallet_count > 0 && smartCount < strat.min_smart_wallet_count) {
    failures.push(`smart wallets: ${smartCount} < ${strat.min_smart_wallet_count}`);
  }
  if (strat.require_smart_wallet_after_dip && candidate.smartWalletSignal?.enteredAfterDip === false) {
    failures.push('smart wallets: no confirmed entry after >=20% ATH dip');
  }

  // ATH distance (dip buy strategy)
  if (strat.max_ath_distance_pct < 0) {
    const athDist = candidate.chart?.distanceFromAthPercent;
    if (athDist != null && athDist > strat.max_ath_distance_pct) {
      failures.push(`ATH distance: ${athDist.toFixed(0)}% > target ${strat.max_ath_distance_pct}%`);
    }
  }
  if (strat.min_ath_distance_pct < 0) {
    const athDist = candidate.chart?.distanceFromAthPercent;
    if (athDist != null && athDist < strat.min_ath_distance_pct) {
      failures.push(`ATH distance: ${athDist.toFixed(0)}% below max dip ${strat.min_ath_distance_pct}%`);
    }
  }

  // Token age
  if (strat.token_age_min_ms > 0 && Number.isFinite(tokenAgeMs) && tokenAgeMs < strat.token_age_min_ms) {
    failures.push(`token age: ${Math.round(tokenAgeMs / 60000)}m < ${Math.round(strat.token_age_min_ms / 60000)}m`);
  }
  if (strat.token_age_max_ms > 0 && Number.isFinite(tokenAgeMs) && tokenAgeMs > strat.token_age_max_ms) {
    failures.push(`token age: ${Math.round(tokenAgeMs / 60000)}m > ${Math.round(strat.token_age_max_ms / 60000)}m`);
  }

  // Social checks
  const hasSocial = candidate.socialCheck?.hasSocial ?? Boolean(candidate.token?.twitter || candidate.token?.website || candidate.token?.telegram);
  const hasTwitter = candidate.socialCheck?.hasTwitter ?? Boolean(candidate.token?.twitter);
  if (strat.require_social && !hasSocial) {
    failures.push('social: missing Twitter/website/Telegram');
  }
  if (strat.require_twitter && !hasTwitter) {
    failures.push('social: missing Twitter');
  }

  // Trending filters
  if (candidate.trending) {
    if (strat.trending_min_volume_usd > 0 && trendingVolume < strat.trending_min_volume_usd) {
      failures.push(`trending volume: ${trendingVolume} < ${strat.trending_min_volume_usd}`);
    }
    if (strat.trending_min_swaps > 0 && trendingSwaps < strat.trending_min_swaps) {
      failures.push(`trending swaps: ${trendingSwaps} < ${strat.trending_min_swaps}`);
    }
    if (strat.trending_max_rug_ratio > 0 && Number.isFinite(rugRatio) && rugRatio > strat.trending_max_rug_ratio) {
      failures.push(`trending rug ratio: ${rugRatio} > ${strat.trending_max_rug_ratio}`);
    }
    if (strat.trending_max_bundler_rate > 0 && Number.isFinite(bundlerRate) && bundlerRate > strat.trending_max_bundler_rate) {
      failures.push(`trending bundler rate: ${bundlerRate} > ${strat.trending_max_bundler_rate}`);
    }
    if (Number.isFinite(bundlerRate) && bundlerRate > 0.2) {
      // SOFT FLAG — not a hard reject. Common in memecoins.
      // LLM will evaluate bundler rate in context.
    }
    if (candidate.trending.is_wash_trading === true || candidate.trending.is_wash_trading === 1) {
      failures.push('trending wash trading');
    }
  }

  // Phase 1: RUG DEFENSE HARD FILTERS
  const sec = candidate.security;
  // 1. RugCheck safety score
  const rugMaxScore = Number(strat.rugcheck_max_score ?? 250);
  const rugScore = sec?.rugcheck?.score ?? (sec?.rugcheckSafe?.score ?? null);
  if (Number.isFinite(rugScore) && rugScore > rugMaxScore) {
    failures.push(`rugcheck_score: ${rugScore} > max ${rugMaxScore}`);
  }
  if (sec?.rugcheckSafe?.safe === false) {
    failures.push(`rugcheck_unsafe: ${sec.rugcheckSafe.reason}`);
  }
  // 2. Mint & freeze authority (mutable = dev can change token)
  const requireMintRevoked = strat.require_mint_revoked !== false; // default true
  const requireFreezeRevoked = strat.require_freeze_revoked !== false; // default true
  if (requireMintRevoked && sec?.rugcheck?.mintAuthority) {
    failures.push('mint_authority: active (dev can mint more)');
  }
  if (requireFreezeRevoked && sec?.rugcheck?.freezeAuthority) {
    failures.push('freeze_authority: active (dev can freeze wallets)');
  }
  // 3. LP safety — hard reject for dip_buy/smart_money, soft for sniper
  const requireLpLockedOrBurned = strat.require_lp_safe !== false;
  const isSniperLike = strat.id === 'sniper' || strat.id === 'degen';
  if (requireLpLockedOrBurned && sec?.rugcheck) {
    const { hasBurnedLp, hasLockedLp } = sec.rugcheck;
    if (!hasBurnedLp && !hasLockedLp) {
      if (isSniperLike) {
        // Soft flag: sniper tolerance for fresh tokens that haven't burned LP yet
        // Don't hard reject — let LLM penalize in scoring
      } else {
        failures.push('lp_unsafe: neither burned nor locked');
      }
    }
  }
  // 4. Tax check
  const maxTax = Number(strat.max_total_tax_percent ?? 15);
  const buyTax = sec?.tokenTax?.buyTaxPercent ?? 0;
  const sellTax = sec?.tokenTax?.sellTaxPercent ?? 0;
  const totalTax = buyTax + sellTax;
  if (totalTax > maxTax) {
    failures.push(`tax_too_high: ${totalTax.toFixed(1)}% > ${maxTax}%`);
  }
  if (sec?.tokenTax?.hasHiddenTax) {
    failures.push('hidden_tax_detected');
  }
  // Honeypot detection
  if (sec?.tokenTax?.canSell === false) {
    failures.push('honeypot: cannot sell');
  }
  // 5. Dev wallet analysis
  const maxDevScore = Number(strat.max_dev_rug_score ?? 70);
  const devScore = sec?.devAnalysis?.score ?? 0;
  if (Number.isFinite(devScore) && devScore > maxDevScore) {
    failures.push(`dev_history: rug_score ${devScore} > ${maxDevScore} (${sec?.devAnalysis?.verdict})`);
  }

  // Phase 2: Momentum filter
  if (candidate.momentum) {
    const momFilter = quickMomentumFilter(candidate.momentum, strat);
    if (!momFilter.passed) {
      failures.push(...momFilter.failures);
    }
  }

  // Phase 3: Bundle detection
  if (candidate.bundle) {
    const bundleFilter = bundleFilterResult(candidate.bundle, strat);
    if (!bundleFilter.passed) {
      failures.push(...bundleFilter.failures);
    }
  }

  return { passed: failures.length === 0, failures, strategy: strat.id };
}

export async function buildCandidate({ mint, fee = null, signature = null, graduatedCoin = null, trendingToken = null, route }) {
  const strat = activeStrategy();
  const gmgn = await fetchGmgnTokenInfo(mint);
  const jupiterAsset = await fetchJupiterAsset(mint);
  const holders = await fetchJupiterHolders(mint);
  const chart = await fetchJupiterChartContext(mint);
  const savedWalletExposure = await fetchSavedWalletExposure(mint, holders);
  const twitterNarrative = await fetchTwitterNarrative(graduatedCoin || jupiterAsset, gmgn);

  // Phase 1: Rug Defense enrichments (concurrent with timeouts)
  const [rugcheckReport, tokenSecurity, devWalletAddress] = await Promise.all([
    withTimeout(fetchRugcheckReport(mint), 8_000, null).catch(() => null),
    withTimeout(runTokenSecurityCheck(mint), 6_000, ({ passed: true, failures: [] })).catch(() => ({ passed: true, failures: [] })),
    withTimeout(fetchDevWalletForToken(mint), 5_000, null).catch(() => null),
  ]);
  const rugcheckInfo = extractSecurityFromRugcheck(rugcheckReport);
  const rugcheckStatus = isRugcheckSafe(rugcheckReport);
  const devAnalysis = devWalletAddress
    ? await withTimeout(analyzeDevWallet(devWalletAddress, mint), 10_000, ({ score: 0, verdict: 'neutral' })).catch(() => ({ score: 0, verdict: 'neutral' }))
    : { score: 0, verdict: 'neutral' };

  const priceUsd = firstPositiveNumber(tokenPriceFromGmgn(gmgn), jupiterAsset?.usdPrice, trendingToken?.price);
  const marketCapUsd = firstPositiveNumber(
    marketCapFromGmgn(gmgn),
    jupiterAsset?.mcap,
    jupiterAsset?.fdv,
    trendingToken?.market_cap,
    graduatedCoin?.marketCap,
    graduatedCoin?.usd_market_cap,
  );
  const signalRoute = route || [
    fee ? 'fee' : null,
    graduatedCoin ? 'graduated' : null,
    trendingToken ? 'trending' : null,
  ].filter(Boolean).join('_');

  const candidate = {
    token: {
      mint,
      name: gmgn?.name || jupiterAsset?.name || trendingToken?.name || graduatedCoin?.name || '',
      symbol: gmgn?.symbol || jupiterAsset?.symbol || trendingToken?.symbol || graduatedCoin?.ticker || '',
      gmgnUrl: gmgn?.link?.gmgn || gmgnLink(mint),
      twitter: graduatedCoin?.twitter || jupiterAsset?.twitter || gmgn?.link?.twitter_username || trendingToken?.twitter || '',
      website: graduatedCoin?.website || jupiterAsset?.website || gmgn?.link?.website || '',
      telegram: graduatedCoin?.telegram || gmgn?.link?.telegram || '',
    },
    metrics: {
      priceUsd,
      marketCapUsd,
      liquidityUsd: Number(gmgn?.liquidity ?? jupiterAsset?.liquidity ?? trendingToken?.liquidity ?? 0),
      holderCount: Number(gmgn?.holder_count ?? jupiterAsset?.holderCount ?? trendingToken?.holder_count ?? graduatedCoin?.numHolders ?? 0),
      gmgnTotalFeesSol: Number(gmgn?.total_fee ?? jupiterAsset?.fees ?? 0),
      gmgnTradeFeesSol: Number(gmgn?.trade_fee ?? 0),
      graduatedVolumeUsd: Number(graduatedCoin?.volume ?? 0),
      graduatedMarketCapUsd: Number(graduatedCoin?.marketCap ?? 0),
      trendingVolumeUsd: Number(trendingToken?.volume ?? 0),
      trendingSwaps: Number(trendingToken?.swaps ?? 0),
      trendingHotLevel: Number(trendingToken?.hot_level ?? 0),
      trendingSmartDegenCount: Number(trendingToken?.smart_degen_count ?? 0),
      tokenAgeMs: tokenAgeMsFromSources(gmgn, jupiterAsset, graduatedCoin, trendingToken),
    },
    signals: {
      route: signalRoute,
      label: signalLabel({
        hasFeeClaim: Boolean(fee),
        hasGraduated: Boolean(graduatedCoin),
        hasTrending: Boolean(trendingToken),
      }),
      hasFeeClaim: Boolean(fee),
      hasGraduated: Boolean(graduatedCoin),
      hasTrending: Boolean(trendingToken),
      triggerSignature: signature,
      strategy: strat.id,
    },
    graduation: graduatedCoin,
    trending: trendingToken,
    feeClaim: fee ? buildFeeSnapshot(fee, signature) : null,
    gmgn,
    jupiterAsset,
    holders,
    chart,
    savedWalletExposure,
    smartWalletSignal: buildSmartWalletSignal(savedWalletExposure, chart),
    feeDistribution: fee ? buildFeeDistribution(mint, buildFeeSnapshot(fee, signature), Number(gmgn?.liquidity ?? jupiterAsset?.liquidity ?? trendingToken?.liquidity ?? 0)) : null,
    twitterNarrative,
    socialCheck: null,
    createdAtMs: now(),
    // Phase 1: Rug Defense fields
    security: {
      rugcheck: rugcheckInfo,
      rugcheckSafe: rugcheckStatus,
      tokenTax: tokenSecurity,
      devWallet: devWalletAddress,
      devAnalysis,
    },
  };

  // Phase 2 & 3: Momentum & Bundle (with timeouts, skip for old tokens where irrelevant)
  candidate.socialCheck = buildSocialCheck(candidate.token, twitterNarrative);
  const tokenAgeMin = Number(candidate.metrics?.tokenAgeMs || 0) / 60_000;
  const [momentum, bundle] = await Promise.all([
    withTimeout(analyzeTokenMomentum(mint, { gmgn, jupiterAsset }), 8_000, null).catch(() => null),
    // Bundle detection is only relevant for fresh tokens (< 30 min)
    tokenAgeMin < 30
      ? withTimeout(calculateBundleScore(mint, trendingToken, holders), 10_000, null).catch(() => null)
      : null,
  ]);
  candidate.momentum = momentum;
  candidate.bundle = bundle ?? { score: 0, riskLevel: 'minimal', isBundled: false, isSniperHeavy: false, pattern: 'old_token_skipped' };

  candidate.filters = filterCandidate(candidate);
  return candidate;
}
