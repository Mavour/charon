import { Connection, PublicKey, Transaction, SystemProgram } from '@solana/web3.js';
import { SOLANA_RPC_URL, WSOL_MINT, PUMP_PROGRAM } from '../config.js';

let connection = null;

function getConnection() {
  if (!connection) connection = new Connection(SOLANA_RPC_URL, 'confirmed');
  return connection;
}

/**
 * Simulate a small sell transaction to detect taxes, honeypot, or blacklist.
 * Non-destructive — no real transaction is sent.
 */
export async function simulateSellCheck(mint, walletPubkey, amountRaw = 1000) {
  try {
    const { fetchJupiterSwap } = await import('../liveExecutor.js');
    // Try to simulate a Jupiter swap (input = token, output = WSOL)
    const simulation = await fetchJupiterSwap({
      inputMint: mint,
      outputMint: WSOL_MINT,
      amount: String(amountRaw),
      slippageBps: 9500, // 95% slippage for simulation
      simulateOnly: true,
    });
    return {
      canSell: true,
      simulatedOutput: simulation.outputAmount,
      taxDetected: false,
      reason: 'simulation_passed',
    };
  } catch (err) {
    const msg = String(err.message).toLowerCase();
    if (msg.includes('insufficient') || msg.includes('balance')) {
      return { canSell: false, reason: 'insufficient_balance_for_sim' };
    }
    if (msg.includes('slippage') || msg.includes('tax')) {
      return { canSell: true, taxDetected: true, reason: 'high_tax_or_slippage_detected' };
    }
    if (msg.includes('revert') || msg.includes('failed') || msg.includes('block') || msg.includes('blacklist')) {
      return { canSell: false, reason: `sell_blocked: ${err.message}` };
    }
    return { canSell: null, reason: `sim_error: ${err.message}` };
  }
}

/**
 * Get transfer fee config from token mint via Solana RPC.
 * Detects Token-2022 transfer fees which act as hidden tax.
 */
export async function fetchTokenTaxConfig(mint) {
  try {
    const conn = getConnection();
    const mintInfo = await conn.getParsedAccountInfo(new PublicKey(mint), 'confirmed');
    const data = mintInfo.value?.data?.parsed?.info;
    if (!data) return { hasTax: false, transferFee: null };
    // Token-2022 extension: transfer fees
    const extensions = data.extensions || [];
    for (const ext of extensions) {
      if (ext.extension === 'transferFeeConfig') {
        const fee = ext.state;
        return {
          hasTax: Number(fee.transferFeeBasisPoints || 0) > 0,
          transferFeeBps: Number(fee.transferFeeBasisPoints || 0),
          maxFee: Number(fee.maximumFee || 0),
          transferFee: fee,
        };
      }
    }
    return { hasTax: false, transferFee: null };
  } catch (err) {
    return { hasTax: false, transferFee: null, error: err.message };
  }
}

/**
 * Check if token is Meteora / Pump AMM but has buy-tax sneaked into bonding curve.
 * Uses Jupiter quote comparison: expected vs actual output.
 */
export async function estimateHiddenTax(mint, expectedPriceInSol = 0.01) {
  try {
    const SOL = 1_000_000_000;
    const amountLamports = Math.floor(expectedPriceInSol * SOL);
    const url = new URL('https://api.jup.ag/swap/v2/quote');
    url.searchParams.set('inputMint', WSOL_MINT);
    url.searchParams.set('outputMint', mint);
    url.searchParams.set('amount', String(amountLamports));
    url.searchParams.set('slippageBps', '300');
    url.searchParams.set('restrictIntermediateTokens', 'true');
    const res = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
    if (!res.ok) return { hasHiddenTax: false, taxPercent: null, reason: 'quote_failed' };
    const data = await res.json();
    const outAmount = Number(data.outAmount || 0);
    const expectedOut = Number(data.otherAmountThreshold || 0);
    if (outAmount <= 0 || expectedOut <= 0) return { hasHiddenTax: false };
    // Compare expected vs actual — if outAmount is much lower than expected
    const lossRatio = (expectedOut - outAmount) / expectedOut;
    // Loss > 10% beyond slippage = hidden tax
    const hasHiddenTax = lossRatio > 0.10;
    return {
      hasHiddenTax,
      taxPercent: hasHiddenTax ? Math.round(lossRatio * 1000) / 10 : 0,
      lossRatio,
      outAmount,
      expectedOut,
      reason: hasHiddenTax ? 'quote_deviation_suggests_tax' : 'clean',
    };
  } catch (err) {
    return { hasHiddenTax: false, taxPercent: null, reason: `error: ${err.message}` };
  }
}

/**
 * Comprehensive security check for a token before buying.
 * Returns a safety report with pass/fail verdict.
 */
export async function runTokenSecurityCheck(mint, { walletPubkey = null } = {}) {
  const [taxConfig, hiddenTax] = await Promise.all([
    fetchTokenTaxConfig(mint),
    estimateHiddenTax(mint).catch(() => ({ hasHiddenTax: false })),
  ]);
  const sellSim = walletPubkey
    ? await simulateSellCheck(mint, walletPubkey).catch(() => ({ canSell: null }))
    : { canSell: null, reason: 'no_wallet_provided' };
  const buyTaxPercent = Number(taxConfig.transferFeeBps || 0) / 100;
  const sellTaxPercent = buyTaxPercent; // same usually
  const totalTax = buyTaxPercent + sellTaxPercent;
  const maxTax = 15; // 15% total tax is max acceptable
  const failures = [];
  if (taxConfig.hasTax && totalTax > maxTax) {
    failures.push(`tax_too_high: ${totalTax.toFixed(1)}% > ${maxTax}%`);
  }
  if (hiddenTax.hasHiddenTax) {
    failures.push(`hidden_tax_detected: ~${hiddenTax.taxPercent}%`);
  }
  if (sellSim.canSell === false) {
    failures.push(`honeypot_or_sell_blocked: ${sellSim.reason}`);
  }
  const passed = failures.length === 0;
  return {
    passed,
    failures,
    buyTaxPercent,
    sellTaxPercent,
    hasTransferFee: taxConfig.hasTax,
    hasHiddenTax: hiddenTax.hasHiddenTax,
    canSell: sellSim.canSell,
    sellBlockReason: sellSim.reason,
    taxConfig: taxConfig.transferFee,
  };
}
