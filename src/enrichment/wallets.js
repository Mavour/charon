import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db/connection.js';
import { now } from '../utils.js';
import { PRO_WALLETS_PATH } from '../config.js';

let externalWalletCache = { path: null, mtimeMs: 0, wallets: [] };

function normalizeWallet(row, source = 'db') {
  const address = String(row?.address || row?.wallet || row?.pubkey || '').trim();
  if (!address) return null;
  const winRate = Number(row?.winRate ?? row?.win_rate ?? row?.wr ?? 0);
  const pnlSol = Number(row?.pnlSol ?? row?.pnl_sol ?? row?.pnl ?? row?.profit_sol ?? 0);
  return {
    label: String(row?.label || row?.name || address.slice(0, 8)),
    address,
    winRate: Number.isFinite(winRate) ? winRate : 0,
    pnlSol: Number.isFinite(pnlSol) ? pnlSol : 0,
    source,
  };
}

function parseExternalWalletFile(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);
    const rows = Array.isArray(parsed) ? parsed : parsed.wallets || parsed.proWallets || [];
    return rows.map(row => normalizeWallet(row, 'file')).filter(Boolean);
  }
  return trimmed.split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map((line) => {
      const [labelOrAddress, addressOrWinRate, winRateOrPnl, pnl] = line.split(',').map(part => part.trim());
      const hasLabel = addressOrWinRate && !Number.isFinite(Number(addressOrWinRate));
      return normalizeWallet(hasLabel
        ? { label: labelOrAddress, address: addressOrWinRate, winRate: winRateOrPnl, pnlSol: pnl }
        : { address: labelOrAddress, winRate: addressOrWinRate, pnlSol: winRateOrPnl }, 'file');
    })
    .filter(Boolean);
}

export function externalSavedWallets() {
  const filePath = path.resolve(PRO_WALLETS_PATH);
  try {
    const stat = fs.statSync(filePath);
    if (externalWalletCache.path === filePath && externalWalletCache.mtimeMs === stat.mtimeMs) {
      return externalWalletCache.wallets;
    }
    const wallets = parseExternalWalletFile(fs.readFileSync(filePath, 'utf8'));
    externalWalletCache = { path: filePath, mtimeMs: stat.mtimeMs, wallets };
    return wallets;
  } catch (err) {
    if (err.code !== 'ENOENT') console.log(`[wallets] failed to load ${filePath}: ${err.message}`);
    externalWalletCache = { path: filePath, mtimeMs: 0, wallets: [] };
    return [];
  }
}

export function savedWallets() {
  const rows = db.prepare('SELECT * FROM saved_wallets ORDER BY label').all()
    .map(row => normalizeWallet(row, 'db'))
    .filter(Boolean);
  const byAddress = new Map();
  for (const wallet of [...rows, ...externalSavedWallets()]) {
    const existing = byAddress.get(wallet.address);
    byAddress.set(wallet.address, existing ? { ...existing, ...wallet } : wallet);
  }
  return [...byAddress.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export async function fetchSavedWalletExposure(mint, holders) {
  const wallets = savedWallets();
  if (!wallets.length || !holders?.holders?.length) {
    return { holderCount: 0, smartWalletCount: 0, qualifiedCount: 0, checked: wallets.length, wallets: [] };
  }
  const holderSet = new Set(holders.holders.map(h => h.address));
  const matched = wallets.filter(wallet => holderSet.has(wallet.address));
  const qualified = matched.filter(wallet => Number(wallet.winRate || 0) > 60 || Number(wallet.pnlSol || 0) > 10);
  return {
    holderCount: matched.length,
    smartWalletCount: matched.length,
    qualifiedCount: qualified.length,
    checked: wallets.length,
    wallets: matched.map(w => w.label),
    qualifiedWallets: qualified.map(w => w.label),
    details: matched.map(w => ({
      label: w.label,
      address: w.address,
      winRate: w.winRate,
      pnlSol: w.pnlSol,
      source: w.source,
      qualified: Number(w.winRate || 0) > 60 || Number(w.pnlSol || 0) > 10,
    })),
  };
}

export async function fetchWalletPnl(address) {
  try {
    const url = `https://datapi.jup.ag/v1/pnl?addresses=${encodeURIComponent(address)}&includeClosed=false`;
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) return null;
    const data = await res.json();
    const d = data?.[address] ?? data?.data?.[address] ?? data;
    if (!d || typeof d !== 'object') return null;
    return {
      totalTrades: Number(d.totalTrades ?? d.total_trades ?? 0),
      wins: Number(d.wins ?? d.winCount ?? d.win_count ?? 0),
      winRate: Number(d.winRate ?? d.win_rate ?? 0),
      totalPnlPercent: Number(d.totalPnlPercent ?? d.total_pnl_percent ?? d.totalPnlUsd ?? 0),
    };
  } catch {
    return null;
  }
}
