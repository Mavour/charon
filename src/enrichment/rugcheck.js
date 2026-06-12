import axios from 'axios';
import { now, sleep } from '../utils.js';
import { numSetting } from '../db/settings.js';

const RUGCHECK_API = 'https://api.rugcheck.xyz/v1/tokens';
const rugcheckCache = new Map();
let lastRugcheckAt = 0;

async function paceRugcheckRequest() {
  const delayMs = Math.max(0, numSetting('rugcheck_request_delay_ms', 1500));
  if (!delayMs) return;
  const elapsed = now() - lastRugcheckAt;
  if (elapsed < delayMs) await sleep(delayMs - elapsed);
  lastRugcheckAt = now();
}

export function rugcheckScoreFromReport(report) {
  if (!report) return null;
  // RugCheck score: 0 = good, higher = more risky
  // Some reports have score field, some don't
  const score = Number(report.score ?? report.riskScore ?? report.rug_score ?? -1);
  if (Number.isFinite(score) && score >= 0) return score;
  // Derive from risks count
  const risks = Array.isArray(report.risks) ? report.risks : [];
  if (!risks.length && score === -1) return 0; // clean token with no score field
  // Heuristic: each risk adds points
  const weights = {
    'low liquidity': 20,
    'mutable': 30,
    'freeze enabled': 25,
    'mint enabled': 35,
    'taxable': 40,
    'honeypot': 100,
    'rug pull': 100,
    'unverified': 10,
    'single holder': 15,
    'high ownership': 25,
    'lp burned': -20, // negative = good
    'lp locked': -15,
  };
  let derived = 0;
  for (const risk of risks) {
    const name = String(risk.name || risk.description || risk).toLowerCase();
    let matched = false;
    for (const [key, weight] of Object.entries(weights)) {
      if (name.includes(key)) { derived += weight; matched = true; }
    }
    if (!matched) derived += 10; // unknown risk = 10 points
  }
  return Math.max(0, derived);
}

export function parseRugcheckRisks(report) {
  if (!report) return [];
  const risks = Array.isArray(report.risks) ? report.risks : [];
  return risks.map(r => ({
    name: String(r.name || r.description || 'unknown'),
    level: String(r.level || r.severity || 'medium'),
    score: Number(r.score || r.value || 0),
  }));
}

export function isRugcheckSafe(report, settings = {}) {
  if (!report) return { safe: false, reason: 'no_rugcheck_data' };
  const score = rugcheckScoreFromReport(report);
  const maxScore = Number(settings.rugcheck_max_score ?? numSetting('rugcheck_max_score', 250));
  const risks = parseRugcheckRisks(report);
  const criticalRisks = risks.filter(r =>
    String(r.name).toLowerCase().includes('honeypot') ||
    String(r.name).toLowerCase().includes('rug pull') ||
    String(r.level).toLowerCase() === 'critical' ||
    String(r.level).toLowerCase() === 'danger'
  );
  if (criticalRisks.length > 0) {
    return { safe: false, reason: `critical_risk: ${criticalRisks.map(r => r.name).join(', ')}` };
  }
  if (Number.isFinite(score) && score > maxScore) {
    return { safe: false, reason: `rugcheck_score_too_high: ${score} > ${maxScore}` };
  }
  return { safe: true, score, risks, reason: 'clean' };
}

export async function fetchRugcheckReport(mint, { useCache = true, ttlMs = 60_000 } = {}) {
  const cached = rugcheckCache.get(mint);
  if (useCache && cached && now() - cached.at < ttlMs) return cached.data;
  try {
    await paceRugcheckRequest();
    const res = await axios.get(`${RUGCHECK_API}/${mint}/report`, {
      timeout: 10_000,
      headers: { Accept: 'application/json' },
    });
    const data = res.data;
    rugcheckCache.set(mint, { at: now(), data });
    return data;
  } catch (err) {
    // RugCheck returns 404 for very new tokens (not indexed yet) — that's ok
    if (err.response?.status === 404) {
      rugcheckCache.set(mint, { at: now(), data: null });
      return null;
    }
    console.log(`[rugcheck] ${mint.slice(0, 8)}... ${err.response?.status || ''} ${err.message}`);
    return null;
  }
}

export async function fetchRugcheckSummaryBatch(mints) {
  const result = {};
  for (const mint of mints) {
    result[mint] = await fetchRugcheckReport(mint);
    await sleep(numSetting('rugcheck_request_delay_ms', 1500));
  }
  return result;
}

// Extract key LP/holder info from RugCheck report
export function extractSecurityFromRugcheck(report) {
  if (!report) return null;
  const tokenMeta = report.tokenMeta || {};
  const token = report.token || {};
  const markets = Array.isArray(report.markets) ? report.markets : [];
  const topHolders = Array.isArray(report.topHolders) ? report.topHolders : [];
  // LP analysis
  const lpInfo = markets.map(m => ({
    marketAddress: m.marketAddress || m.address,
    liquidityA: m.liquidityA,
    liquidityB: m.liquidityB,
    lpBurned: m.lp?.burned || false,
    lpLocked: m.lp?.locked || false,
    lpLockExpiry: m.lp?.lockExpiry,
  }));
  const hasBurnedLp = lpInfo.some(lp => lp.lpBurned);
  const hasLockedLp = lpInfo.some(lp => lp.lpLocked);
  // Detect mint authority
  const mintAuthority = token.mintAuthority || tokenMeta.mintAuthority || null;
  const freezeAuthority = token.freezeAuthority || tokenMeta.freezeAuthority || null;
  const mutable = Boolean(token.mutable ?? tokenMeta.mutable);
  // Top holder concentration beyond what Jupiter gives
  const largestPct = topHolders.length ? Number(topHolders[0]?.pct || topHolders[0]?.percentage || 0) : 0;
  const top5Pct = topHolders.slice(0, 5).reduce((sum, h) => sum + Number(h.pct || h.percentage || 0), 0);
  return {
    mintAuthority,
    freezeAuthority,
    mutable,
    hasBurnedLp,
    hasLockedLp,
    lpInfo,
    largestHolderPct: largestPct,
    top5HolderPct: top5Pct,
    totalHolders: Number(token.holders || report.totalHolders || topHolders.length || 0),
    score: rugcheckScoreFromReport(report),
    risks: parseRugcheckRisks(report),
  };
}
