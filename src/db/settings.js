import { db } from './connection.js';

export function setting(key, fallback = '') {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? fallback;
}

export function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

export function boolSetting(key, fallback = false) {
  const value = setting(key, fallback ? 'true' : 'false');
  return value === 'true' || value === '1' || value === 'yes';
}

export function numSetting(key, fallback = 0) {
  const value = Number(setting(key, String(fallback)));
  return Number.isFinite(value) ? value : fallback;
}

const strategyCache = { id: null, config: null, at: 0 };

export function activeStrategy() {
  if (strategyCache.config && Date.now() - strategyCache.at < 5000) return strategyCache.config;
  const row = db.prepare('SELECT * FROM strategies WHERE enabled = 1 LIMIT 1').get();
  if (!row) {
    const fallback = strategyById('sniper');
    if (fallback) return fallback;
    return defaultStrategy();
  }
  const config = { id: row.id, name: row.name, ...JSON.parse(row.config_json) };
  strategyCache.id = row.id;
  strategyCache.config = config;
  strategyCache.at = Date.now();
  return config;
}

export function strategyById(id) {
  const row = db.prepare('SELECT * FROM strategies WHERE id = ?').get(id);
  if (!row) return null;
  return { id: row.id, name: row.name, ...JSON.parse(row.config_json) };
}

export function allStrategies() {
  return db.prepare('SELECT * FROM strategies ORDER BY id').all().map(row => ({
    id: row.id,
    name: row.name,
    enabled: Boolean(row.enabled),
    ...JSON.parse(row.config_json),
  }));
}

export function setActiveStrategy(id) {
  db.prepare('UPDATE strategies SET enabled = 0').run();
  db.prepare('UPDATE strategies SET enabled = 1 WHERE id = ?').run(id);
  strategyCache.config = null;
  strategyCache.at = 0;
}

export function updateStrategyConfig(id, config) {
  db.prepare('UPDATE strategies SET config_json = ? WHERE id = ?').run(JSON.stringify(config), id);
  if (strategyCache.id === id) {
    strategyCache.config = null;
    strategyCache.at = 0;
  }
}

export function strategySetting(key, fallback) {
  const strat = activeStrategy();
  if (strat[key] !== undefined && strat[key] !== null) return strat[key];
  return numSetting(key, fallback);
}

function defaultStrategy() {
  return {
    id: 'sniper', name: 'Sniper',
    entry_mode: 'immediate', min_source_count: 2, require_fee_claim: true,
    token_age_max_ms: 21600000, min_mcap_usd: 10000, max_mcap_usd: 150000,
    min_fee_claim_sol: 2.0, min_gmgn_total_fee_sol: 10, min_holders: 0,
    max_top20_holder_percent: 45, min_saved_wallet_holders: 0, max_ath_distance_pct: 0,
    min_graduated_volume_usd: 0, trending_min_volume_usd: 5000, trending_min_swaps: 50,
    trending_max_rug_ratio: 0.15, trending_max_bundler_rate: 0.2,
    position_size_sol: 0.3, max_open_positions: 3,
    tp_percent: 150, sl_percent: -40, trailing_enabled: true, trailing_percent: 35,
    partial_tp: true, partial_tp_at_percent: 100, partial_tp_sell_percent: 40,
    max_hold_ms: 7200000, use_llm: true, llm_min_confidence: 75,
    min_fee_unique_recipients: 0, min_fee_claims_30m: 0,
    reject_concentrated_fee_recipients: true, min_smart_wallet_count: 0,
    require_smart_wallet_after_dip: false, volume_drop_exit_percent: 80,
  };
}
