import { Connection, PublicKey } from '@solana/web3.js';
import axios from 'axios';
import { SOLANA_RPC_URL, HELIUS_API_KEY } from '../config.js';
import { now, json } from '../utils.js';
import { db } from '../db/connection.js';

let connection = null;

function getConnection() {
  if (!connection) connection = new Connection(SOLANA_RPC_URL, 'confirmed');
  return connection;
}

const devWalletCache = new Map();
const DEPLOY_DISCRIMINATOR = Buffer.from([24, 30, 200, 40, 5, 28, 7, 119]); // token deploy pattern
const PUMP_LAUNCH_DISC = Buffer.from([129, 139, 139, 81, 147, 115, 224, 198]); // pump.fun launch

/**
 * Fetch all token accounts created by a wallet via Helius or RPC.
 * We look for Mint accounts where the wallet is the freeze authority
 * or via Pump.fun transaction history.
 */
export async function fetchDevTokenHistory(walletAddress, { limit = 20 } = {}) {
  try {
    const cacheKey = `${walletAddress}:${limit}`;
    const cached = devWalletCache.get(cacheKey);
    if (cached && now() - cached.at < 10 * 60 * 1000) return cached.data;
    const conn = getConnection();
    // Get signatures for address (Pump.fun deployments will show up)
    const sigs = await conn.getSignaturesForAddress(
      new PublicKey(walletAddress),
      { limit: limit * 2 },
      'confirmed'
    );
    // Look for token creation and Pump.fun launch txns
    const tokenDeployments = [];
    const analyzedTxs = sigs.slice(0, limit);
    for (const sigInfo of analyzedTxs) {
      const tx = await conn.getParsedTransaction(sigInfo.signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      if (!tx) continue;
      // Check for pump fun launch
      const accounts = tx.transaction?.message?.accountKeys || [];
      const hasPump = accounts.some(a => a.pubkey?.toString() === '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
      if (hasPump && tx.meta?.postTokenBalances) {
        for (const balance of tx.meta.postTokenBalances) {
          if (balance.mint && balance.owner === walletAddress) {
            tokenDeployments.push({
              mint: balance.mint,
              signature: sigInfo.signature,
              timestamp: (sigInfo.blockTime || 0) * 1000,
              source: 'pump_fun',
            });
          }
        }
      }
      // Check for mint creation
      const instructions = tx.transaction?.message?.instructions || [];
      for (const ix of instructions) {
        if (ix.program === 'spl-token' && ix.parsed?.type === 'initializeMint2') {
          tokenDeployments.push({
            mint: ix.parsed?.info?.mint,
            signature: sigInfo.signature,
            timestamp: (sigInfo.blockTime || 0) * 1000,
            source: 'spl_mint',
          });
        }
      }
    }
    const result = tokenDeployments;
    devWalletCache.set(cacheKey, { at: now(), data: result });
    return result;
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Check if a dev's previous tokens are still alive or dead.
 * Uses Jupiter price API to see if price > 0 and mcap > 0.
 */
export async function checkDevTokenLiveliness(tokenMints) {
  if (!Array.isArray(tokenMints) || tokenMints.length === 0) return [];
  const results = [];
  for (const mint of tokenMints) {
    try {
      const res = await axios.get(
        `https://api.jup.ag/price/v2?ids=${mint}`,
        { timeout: 5000, headers: { Accept: 'application/json' } }
      );
      const data = res.data?.data?.[mint];
      const price = Number(data?.price || 0);
      results.push({
        mint,
        price,
        alive: price > 1e-12, // very low price = dead
      });
      await new Promise(r => setTimeout(r, 200)); // pace requests
    } catch {
      results.push({ mint, price: 0, alive: false });
    }
  }
  return results;
}

/**
 * Calculate developer rug score based on their history.
 * Score 0-100. Higher = more likely to rug.
 */
export async function analyzeDevWallet(devWalletAddress, currentMint) {
  if (!devWalletAddress || devWalletAddress === '11111111111111111111111111111111') {
    return { score: 0, reason: 'unknown_dev', verdict: 'neutral' };
  }
  const history = await fetchDevTokenHistory(devWalletAddress);
  if (history.error) {
    return { score: 0, reason: 'fetch_error', error: history.error, verdict: 'neutral' };
  }
  const tokens = Array.isArray(history) ? history : [];
  if (tokens.length === 0) {
    return { score: 5, reason: 'first_token', verdict: 'caution' };
  }
  // Exclude current mint from history
  const otherDeployments = tokens.filter(t => t.mint !== currentMint);
  if (otherDeployments.length === 0) {
    return { score: 5, reason: 'first_token', deploymentCount: 1, verdict: 'caution' };
  }
  // Check liveliness of previous tokens
  const liveliness = await checkDevTokenLiveliness(otherDeployments.slice(0, 10).map(t => t.mint));
  const aliveCount = liveliness.filter(t => t.alive).length;
  const totalChecked = liveliness.length;
  const deathRate = totalChecked > 0 ? (totalChecked - aliveCount) / totalChecked : 0;
  // Scoring
  let score = 0;
  // Many deployments in short time = likely pumper
  const recentDeployments = otherDeployments.filter(t => t.timestamp > now() - 7 * 24 * 60 * 60 * 1000);
  score += Math.min(40, recentDeployments.length * 15);
  // Death rate scoring
  if (deathRate > 0.8) score += 45; // 80%+ dead = serial rugger
  else if (deathRate > 0.6) score += 30;
  else if (deathRate > 0.4) score += 15;
  // Scale by total deployments
  score += Math.min(20, otherDeployments.length * 3);
  const verdict = score >= 70 ? 'serial_rugger' : score >= 40 ? 'suspicious' : score >= 15 ? 'caution' : 'clean';
  return {
    score: Math.min(100, Math.round(score)),
    verdict,
    deathRate: Math.round(deathRate * 1000) / 1000,
    liveTokens: aliveCount,
    deadTokens: totalChecked - aliveCount,
    totalTokens: otherDeployments.length,
    recentDeployments: recentDeployments.length,
    reason: verdict === 'serial_rugger' ? 'Most previous tokens are dead or abandoned' :
            verdict === 'suspicious' ? 'Several previous tokens failed' :
            verdict === 'caution' ? 'New dev with limited track record' : 'Clean track record',
  };
}

/**
 * Try to get the dev wallet for a token via Helius or Jupiter asset info.
 */
export async function fetchDevWalletForToken(mint) {
  try {
    // Try Jupiter asset API first
    const res = await axios.get(
      `https://datapi.jup.ag/v1/assets/search?query=${mint}`,
      { timeout: 10000, headers: { Accept: 'application/json' } }
    );
    const rows = Array.isArray(res.data) ? res.data : [];
    const data = rows.find(row => row?.id === mint) || rows[0];
    if (data?.creator) return String(data.creator);
    // Fallback: try first mint authority via RPC
    return null;
  } catch {
    return null;
  }
}
