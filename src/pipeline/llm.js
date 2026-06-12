import axios from 'axios';
import { ENABLE_LLM, LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, LLM_TIMEOUT_MS } from '../config.js';
import { now, stripThinking, strictJsonFromText } from '../utils.js';
import { numSetting } from '../db/settings.js';
import { db } from '../db/connection.js';

export function normalizeDecision(parsed, fallbackReason = '') {
  const verdict = ['BUY', 'WATCH', 'PASS'].includes(String(parsed?.verdict).toUpperCase())
    ? String(parsed.verdict).toUpperCase()
    : 'WATCH';
  return {
    verdict,
    confidence: Math.max(0, Math.min(100, Number(parsed?.confidence) || 0)),
    reason: String(parsed?.reason || fallbackReason).slice(0, 1000),
    risks: Array.isArray(parsed?.risks) ? parsed.risks.map(String).slice(0, 8) : [],
    suggested_tp_percent: Number(parsed?.suggested_tp_percent) || numSetting('default_tp_percent', 50),
    suggested_sl_percent: Number(parsed?.suggested_sl_percent) || numSetting('default_sl_percent', -25),
    raw: parsed,
  };
}

export function activeLessonsForPrompt(limit = 6) {
  return db.prepare(`
    SELECT lesson
    FROM learning_lessons
    WHERE status = 'active'
    ORDER BY id DESC
    LIMIT ?
  `).all(limit).map(row => row.lesson);
}

export function compactCandidateForLlm(row) {
  const c = row.candidate;
  const athWindow = c.chart?.windows?.find(window => window.label === 'ath_context_24h_5m' && window.available)
    || c.chart?.windows?.find(window => window.label === 'recent_24h_5m' && window.available);
  return {
    candidate_id: row.id,
    mint: c.token?.mint,
    route: c.signals?.route,
    token: { name: c.token?.name, symbol: c.token?.symbol, twitter: c.token?.twitter },
    metrics: {
      marketCapUsd: c.metrics?.marketCapUsd,
      liquidityUsd: c.metrics?.liquidityUsd,
      holderCount: c.metrics?.holderCount,
      tokenAgeMs: c.metrics?.tokenAgeMs,
      totalFeesSol: c.metrics?.gmgnTotalFeesSol,
      graduatedVolumeUsd: c.metrics?.graduatedVolumeUsd,
      trendingVolumeUsd: c.metrics?.trendingVolumeUsd,
      trendingSwaps: c.metrics?.trendingSwaps,
      trendingSmartDegenCount: c.metrics?.trendingSmartDegenCount,
    },
    feeClaim: c.feeClaim ? {
      distributedSol: c.feeClaim.distributedSol,
      uniqueRecipientCount: c.feeClaim.uniqueRecipientCount,
    } : null,
    feeDistribution: c.feeDistribution ? {
      uniqueRecipients30m: c.feeDistribution.uniqueRecipients30m,
      totalDistributedSol30m: c.feeDistribution.totalDistributedSol30m,
      organicRecipientDistribution: c.feeDistribution.organicRecipientDistribution,
      consistent30m: c.feeDistribution.consistent30m,
    } : null,
    holders: {
      count: c.holders?.count,
      top20Percent: c.holders?.top20Percent,
      maxHolderPercent: c.holders?.maxHolderPercent,
    },
    chart: {
      distanceFromAthPercent: c.chart?.distanceFromAthPercent ?? c.chart?.belowRangeHighPercent,
      athContext24h: athWindow ? {
        current: athWindow.current,
        distanceFromHighPercent: athWindow.belowHighPercent,
        aboveLowPercent: athWindow.aboveLowPercent,
      } : null,
    },
    smartWalletSignal: c.smartWalletSignal ? {
      holderCount: c.smartWalletSignal.holderCount,
      qualifiedCount: c.smartWalletSignal.qualifiedCount,
      enteredAfterDip: c.smartWalletSignal.enteredAfterDip,
      distanceFromAthPercent: c.smartWalletSignal.distanceFromAthPercent,
    } : null,
    socialCheck: {
      hasTwitter: c.socialCheck?.hasTwitter,
      tweetAgeHours: c.socialCheck?.tweetAgeHours,
    },
    security: c.security ? {
      rugcheckScore: c.security.rugcheck?.score,
      rugcheckRisks: (c.security.rugcheck?.risks || []).slice(0, 5).map(r => r.name),
      mintAuthorityActive: Boolean(c.security.rugcheck?.mintAuthority),
      freezeAuthorityActive: Boolean(c.security.rugcheck?.freezeAuthority),
      lpBurned: Boolean(c.security.rugcheck?.hasBurnedLp),
      lpLocked: Boolean(c.security.rugcheck?.hasLockedLp),
      totalTaxPercent: (c.security.tokenTax?.buyTaxPercent || 0) + (c.security.tokenTax?.sellTaxPercent || 0),
      sellBlocked: c.security.tokenTax?.canSell === false,
      hiddenTax: Boolean(c.security.tokenTax?.hasHiddenTax),
      devRugScore: c.security.devAnalysis?.score,
      devVerdict: c.security.devAnalysis?.verdict,
    } : null,
    momentum: c.momentum ? {
      score: c.momentum.score,
      classification: c.momentum.classification,
      isOrganic: Boolean(c.momentum.isOrganic),
      keyFactors: (c.momentum.factors || []).slice(0, 5),
      volumeChangePct: c.momentum.candleMomentum?.volumeChangePct,
      bullishRatio: c.momentum.candleMomentum?.bullishRatio,
      avgPriceChangePct: c.momentum.candleMomentum?.avgPriceChangePct,
      volumePumpDump: Boolean(c.momentum.candleMomentum?.volumePumpDump),
      holderGrowthRate: c.momentum.holderGrowth?.growthRateAvg,
      liquidityHealth: c.momentum.liquidityHealth?.label,
    } : null,
    bundle: c.bundle ? {
      score: c.bundle.score,
      riskLevel: c.bundle.riskLevel,
      isBundled: Boolean(c.bundle.isBundled),
      isSniperHeavy: Boolean(c.bundle.isSniperHeavy),
      gmgnBundlerRate: c.bundle.gmgnBundlerRate,
      firstMinuteTxns: c.bundle.transferAnalysis?.firstMinuteTxns,
      pattern: c.bundle.transferAnalysis?.pattern,
    } : null,
    trending: c.trending ? {
      volume: c.trending.volume,
      swaps: c.trending.swaps,
      rug_ratio: c.trending.rug_ratio,
      bundler_rate: c.trending.bundler_rate,
      is_wash_trading: c.trending.is_wash_trading,
    } : null,
    filters: { passed: c.filters?.passed, failures: c.filters?.failures?.slice(0, 3) },
  };
}

export async function decideCandidateBatch(rows, triggerCandidateId) {
  if (!ENABLE_LLM || !LLM_API_KEY) {
    return {
      verdict: 'WATCH',
      confidence: 0,
      selected_candidate_id: null,
      selected_mint: null,
      reason: 'LLM disabled or LLM_API_KEY missing.',
      risks: ['no_llm_decision'],
      suggested_tp_percent: numSetting('default_tp_percent', 50),
      suggested_sl_percent: numSetting('default_sl_percent', -25),
      raw: null,
    };
  }

  const system = [
    'You are Charon - Solana lowcap memecoin AI. Your goal: find tokens with REAL momentum, not rugs.',
    'Task: screen token candidates and DECIDE to buy or not.',
    'Return strict JSON only.',
    '',
    'CRITICAL RULE: Your win rate is 11%. You must be MORE selective. Quality over quantity.',
    '',
    'DECISION STRUCTURE:',
    'Confidence score 0-100. Thresholds:',
    '- Confidence >= 70 -> BUY',
    '- 40-69 -> WATCH',
    '- <40 -> PASS',
    '',
    'CONFIDENCE COMPONENTS (total 100%):',
    '',
    '1. VOLUME & LIQUIDITY (weight 30%) - MOST IMPORTANT SIGNAL',
    '   - Trending volume > $5K (not wash traded) -> +15 (real activity)',
    '   - Trending volume $1K-$5K -> +5 (some activity)',
    '   - Trending volume < $500 -> -10 (dead token, likely rug)',
    '   - Liquidity > $10K -> +10',
    '   - 10+ unique swaps in last 5m -> +10 (organic trading)',
    '   - Fee claim >= 1 SOL -> +10 (proof of real fees)',
    '   - Fee distributed to 5+ unique recipients -> +10 (organic distribution)',
    '   - Volume dropped > 80% from peak -> -15 (dumping, avoid)',
    '',
    '2. SMART WALLET & HOLDER QUALITY (weight 25%)',
    '   - 2+ smart wallets entered -> +20 (smart money is in)',
    '   - 1 smart wallet entered -> +10 (early signal)',
    '   - 0 smart wallets -> -5 (no smart money interested)',
    '   - Holder count 200-2000 -> +10 (organic spread)',
    '   - Top 20 holder < 40% -> +10 (decent distribution)',
    '   - Top 20 holder > 60% -> -15 (too concentrated, avoid)',
    '   - Saved wallet holders > 0 -> +5 (known wallets see potential)',
    '',
    '3. DIP & TIMING (weight 25%)',
    '   - Token down 25-60% from ATH -> +15 (dip buy - best risk/reward)',
    '   - Token down 10-25% from ATH -> +5 (moderate dip)',
    '   - Token just pumped (0-10% from ATH) -> -15 (FOMO risk, skip)',
    '   - Token age 30 min - 6 hours -> +10 (still fresh)',
    '   - Token age > 12 hours without recovery -> -10 (likely dead)',
    '   - Age < 20 min -> -10 (too early, let it cook)',
    '',
    '4. MARKET CAP & POSITIONING (weight 20%)',
    '   - Market cap $7k-$15k -> +20 (PRIME sweet spot - best risk/reward)',
    '   - Market cap $15k-$35k -> +10 (still ok, moderate upside)',
    '   - Market cap $35k-$50k -> 0 (neutral, limited upside)',
    '   - Market cap > $50k -> -15 (exit liquidity zone, skip)',
    '   - Market cap < $5k -> -10 (too small, fresh snipe target)',
    '   - Social exists (Twitter/Telegram) -> +5',
    '   - No social at all -> -5 (sketchy)',
    '',
    '5. RUG & SECURITY DEFENSE (weight 20%) - NON-NEGOTIABLE',
    '   - RugCheck score 0-50 (safe) -> +15',
    '   - RugCheck score 50-150 (moderate risk) -> +5',
    '   - RugCheck score 150-250 (risky) -> -15',
    '   - RugCheck score >250 or critical risks found -> -30 or AUTO-PASS',
    '   - Mint authority REVOKED -> +10 (dev cannot print more)',
    '   - Mint authority ACTIVE -> -15 (dev can mint infinite tokens)',
    '   - Freeze authority REVOKED -> +5',
    '   - Freeze authority ACTIVE -> -10 (dev can freeze wallets)',
    '   - LP tokens BURNED -> +10 (liquidity locked forever)',
    '   - LP tokens LOCKED -> +5 (liquidity secured)',
    '   - LP tokens not burned/locked -> -20 (dev can rug liquidity)',
    '   - Dev wallet clean track record -> +10',
    '   - Dev wallet suspicious (1 suspicious project) -> -5',
    '   - Dev wallet serial rugger (>70% tokens dead) -> -25 or AUTO-PASS',
    '   - Buy+Sell tax total < 3% -> +5 (low friction)',
    '   - Buy+Sell tax total 3-10% -> 0 (acceptable)',
    '   - Buy+Sell tax total > 10% -> -15 (tax trap)',
    '   - Hidden tax detected (quote deviation) -> -20',
    '   - Honeypot / sell blocked -> -50 or AUTO-PASS',
    '',
    'SOFT FLAGS (reduce confidence, do NOT auto-reject):',
    '   - Top 20 holder > 50% but < 60% -> -5 (common, tiny penalty)',
    '   - Top 20 holder > 60% -> -15 (too concentrated)',
    '   - Bundler rate > 20% -> -5 (many tokens have this)',
    '   - Fee only to 1-2 addresses -> 0 (neutral, common)',
    '   - No fee claim data -> 0 (neutral)',
    '   - No social / Twitter -> -5',
    '   - Token age < 20 min -> -5',
    '   - Momentum score 50-69 (moderate) -> 0',
    '   - Momentum score 30-49 (weak) -> -10',
    '   - Momentum score < 30 (dead/dying) -> -20',
    '   - Volume pump & dump detected -> -15',
    '   - Bundle score 30-59 (moderate bundle risk) -> -10',
    '   - Bundle score 60+ (high bundle/sniper flood) -> -25 or AUTO-PASS',
    '   - First minute txn > 30 (sniper invasion) -> -15',
    '',
    'AVOID THESE PATTERNS (they rug 90% of the time):',
    '   - Token just pumped and is near ATH',
    '   - Volume dropping fast from recent peak',
    '   - No smart wallets at all + top 20 holder > 60%',
    '   - Less than 200 holders (fresh snipe target)',
    '   - Market cap > $200K with no volume (dumping)',
    '   - Market cap > $50K (exit liquidity, limited upside)',
    '   - Mint authority ACTIVE (dev can print more supply anytime)',
    '   - Freeze authority ACTIVE (dev can freeze wallets = authoritarian control)',
    '   - LP not burned or locked (dev can pull liquidity = instant rug)',
    '   - Dev wallet is a serial rugger (>70% dead tokens in history)',
    '   - Tax > 10% or hidden tax detected (tax trap)',
    '   - Sell blocked / honeypot pattern',
    '   - RugCheck critical risk or score > 250',
    '',
    'PREFER:',
    '   - Dip from ATH (25-60% down) with volume holding up',
    '   - Smart wallets entered recently',
    '   - 200+ holders with growing count',
    '   - Real trading volume (not wash traded, has fees)',
    '   - Market cap $7K-$15K (prime sweet spot)',
    '   - Bundle score < 30 (organic, no sniper flood)',
    '',
    'OUTPUT MUST BE VALID JSON ONLY with format:',
    '{',
    '  "verdict": "BUY|WATCH|PASS",',
    '  "confidence": <0-100>,',
    '  "reason": "short reason",',
    '  "risks": ["risk1", "risk2"],',
    '  "suggested_tp_percent": 200,',
    '  "suggested_sl_percent": -15',
    '}',
  ].join(' ');
  const user = {
    task: 'Pick the best dry-run buy candidate from this recent batch, or choose none.',
    recent_lessons: activeLessonsForPrompt(),
    output_schema: {
      verdict: 'BUY|WATCH|PASS',
      selected_candidate_id: 'integer candidate_id when verdict is BUY, otherwise null',
      selected_mint: 'mint string when verdict is BUY, otherwise null',
      confidence: 'number 0-100',
      reason: 'short string',
      risks: ['short strings'],
      suggested_tp_percent: 'positive number',
      suggested_sl_percent: 'negative number',
    },
    trigger_candidate_id: triggerCandidateId,
    candidates: rows.map(compactCandidateForLlm),
  };

  try {
    const res = await axios.post(`${LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      model: LLM_MODEL,
      temperature: 0.2,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(user) },
      ],
    }, {
      timeout: LLM_TIMEOUT_MS,
      headers: { authorization: `Bearer ${LLM_API_KEY}`, 'content-type': 'application/json' },
    });
    const content = res.data?.choices?.[0]?.message?.content || '';
    const parsed = strictJsonFromText(content);
    const decision = normalizeDecision(parsed);
    const selectedId = Number(parsed.selected_candidate_id);
    const selectedMint = String(parsed.selected_mint || '');
    let row = rows.find(item => item.id === selectedId || item.candidate.token?.mint === selectedMint);
    if (!row && decision.verdict === 'BUY') {
      row = rows.find(item => item.id === Number(triggerCandidateId))
        || (rows.length === 1 ? rows[0] : null);
    }
    return {
      ...decision,
      selected_candidate_id: decision.verdict === 'BUY' && row ? row.id : null,
      selected_mint: decision.verdict === 'BUY' && row ? row.candidate.token.mint : null,
      selected_row: decision.verdict === 'BUY' && row ? row : null,
    };
  } catch (err) {
    console.log(`[llm] batch failed: ${err.message}`);
    return {
      verdict: 'WATCH',
      confidence: 0,
      selected_candidate_id: null,
      selected_mint: null,
      reason: `LLM failed: ${err.message}`,
      risks: ['llm_error'],
      suggested_tp_percent: numSetting('default_tp_percent', 50),
      suggested_sl_percent: numSetting('default_sl_percent', -25),
      raw: { error: err.message },
    };
  }
}

export async function decideCandidate(candidate) {
  const pseudoRow = { id: 0, candidate };
  const decision = await decideCandidateBatch([pseudoRow], 0);
  return normalizeDecision(decision.raw || decision, decision.reason);
}
