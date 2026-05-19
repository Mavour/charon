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
    signals: c.signals,
    token: c.token,
    metrics: c.metrics,
    feeClaim: c.feeClaim,
    feeDistribution: c.feeDistribution,
    trending: c.trending,
    graduation: c.graduation,
    holders: c.holders,
    chart: {
      purpose: 'ATH/range context only. Do not treat large 24h change as bullish/bearish momentum by itself.',
      currentNative: c.chart?.currentNative,
      rangeHighNative: c.chart?.rangeHighNative,
      distanceFromAthPercent: c.chart?.distanceFromAthPercent ?? c.chart?.belowRangeHighPercent,
      topBlastRisk: c.chart?.topBlastRisk,
      athContext24h: athWindow ? {
        current: athWindow.current,
        high: athWindow.high,
        low: athWindow.low,
        distanceFromHighPercent: athWindow.belowHighPercent,
        aboveLowPercent: athWindow.aboveLowPercent,
      } : null,
      windows: c.chart?.windows,
    },
    savedWalletExposure: c.savedWalletExposure,
    smartWalletSignal: c.smartWalletSignal,
    twitterNarrative: c.twitterNarrative,
    socialCheck: c.socialCheck,
    filters: c.filters,
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
    'You are Charon - Solana lowcap trench AI.',
    'Task: screen token candidates and DECIDE to buy or not.',
    'Return strict JSON only.',
    '',
    'DECISION STRUCTURE:',
    'Confidence score 0-100. Thresholds:',
    '- Confidence >= 75 -> BUY',
    '- 40-74 -> WATCH',
    '- <40 -> PASS',
    '',
    'CONFIDENCE COMPONENTS:',
    '',
    '1. FEE ANALYSIS (weight 35%)',
    '   - Fee claim >= 2 SOL -> +15',
    '   - Fee distributed to >= 5 unique recipients -> +10 (organic)',
    '   - Fee consistent in last 30 min -> +10',
    '   - Fee only to 1-2 addresses -> -20 (FAKE, likely rug)',
    '   - Fee/TVL ratio > 0.5 -> +10',
    '',
    '2. LOW CAP POSITIONING (weight 25%)',
    '   - Market cap $10k-$50k -> +15 (sweet spot)',
    '   - Market cap $50k-$150k -> +5 (ok, less upside)',
    '   - Market cap > $200k -> -10 (too big for trench)',
    '   - Holders 300-2000 -> +10 (organic)',
    '   - Top 20 holder < 40% -> +10',
    '   - Top 20 holder > 50% -> REJECT',
    '',
    '3. SMART WALLET TRACKING (weight 20%) - BOOST ONLY, NOT A GATE',
    '   - 0 smart wallets in token -> 0 (neutral, do not reject)',
    '   - 1 smart wallet entered -> +10 (early signal)',
    '   - 2+ smart wallets entered separately -> +20 (strong confirmation)',
    '   - Smart wallet bought while token down >= 20% from ATH -> +15 extra (dip buy pattern)',
    '   NOTE: No smart wallet present is NOT a rejection reason. Only a boost.',
    '',
    '4. DIP & TIMING (weight 20%)',
    '   - Token down 25-50% from ATH -> +15 (dip buy moment)',
    '   - Token just pumped (0-10% from ATH) -> -10 (FOMO risk)',
    '   - Token age 30 min - 6 hours -> +10 (still fresh)',
    '   - Token age > 12 hours without recovery -> -10 (dead)',
    '',
    '5. REJECT CONDITIONS (no hesitation, PASS immediately)',
    '   - Bundler rate > 20%',
    '   - Wash trading flag from GMGN/Jupiter',
    '   - Top 20 holder > 50%',
    '   - Dev still holds > 10% supply',
    '   - Fee claim only to 1-2 addresses (fake distribution)',
    '   - Volume dropped > 80% from peak in 30 min',
    '',
    'OUTPUT MUST BE VALID JSON ONLY with format:',
    '{',
    '  "verdict": "BUY|WATCH|PASS",',
    '  "confidence": <0-100>,',
    '  "reason": "short reason",',
    '  "risks": ["risk1", "risk2"],',
    '  "suggested_tp_percent": 150,',
    '  "suggested_sl_percent": -40',
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
