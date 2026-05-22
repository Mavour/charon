import Database from 'better-sqlite3';
import { DB_PATH } from '../config.js';

export const db = new Database(DB_PATH);

export function initDb() {
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS saved_wallets (
      label TEXT PRIMARY KEY,
      address TEXT NOT NULL UNIQUE,
      created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      signature TEXT,
      signal_key TEXT,
      candidate_json TEXT NOT NULL,
      filter_result_json TEXT NOT NULL,
      UNIQUE(signature, mint)
    );
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER,
      mint TEXT NOT NULL,
      kind TEXT NOT NULL,
      sent_at_ms INTEGER NOT NULL,
      telegram_message_id INTEGER,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS llm_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL,
      mint TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      verdict TEXT NOT NULL,
      confidence REAL NOT NULL,
      reason TEXT,
      risks_json TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS llm_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at_ms INTEGER NOT NULL,
      trigger_candidate_id INTEGER,
      selected_candidate_id INTEGER,
      selected_mint TEXT,
      verdict TEXT NOT NULL,
      confidence REAL NOT NULL,
      reason TEXT,
      risks_json TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      candidate_ids_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dry_run_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER,
      mint TEXT NOT NULL,
      symbol TEXT,
      status TEXT NOT NULL,
      opened_at_ms INTEGER NOT NULL,
      closed_at_ms INTEGER,
      size_sol REAL NOT NULL,
      entry_price REAL,
      entry_mcap REAL,
      token_amount_est REAL,
      high_water_price REAL,
      high_water_mcap REAL,
      tp_percent REAL NOT NULL,
      sl_percent REAL NOT NULL,
      trailing_enabled INTEGER NOT NULL,
      trailing_percent REAL NOT NULL,
      trailing_armed INTEGER NOT NULL DEFAULT 0,
      exit_price REAL,
      exit_mcap REAL,
      exit_reason TEXT,
      pnl_percent REAL,
      pnl_sol REAL,
      llm_decision_id INTEGER,
      execution_mode TEXT DEFAULT 'dry_run',
      entry_signature TEXT,
      exit_signature TEXT,
      token_amount_raw TEXT,
      snapshot_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dry_run_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id INTEGER NOT NULL,
      mint TEXT NOT NULL,
      side TEXT NOT NULL,
      at_ms INTEGER NOT NULL,
      price REAL,
      mcap REAL,
      size_sol REAL,
      token_amount_est REAL,
      reason TEXT,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tp_sl_rules (
      position_id INTEGER PRIMARY KEY,
      tp_percent REAL NOT NULL,
      sl_percent REAL NOT NULL,
      trailing_enabled INTEGER NOT NULL,
      trailing_percent REAL NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trade_intents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL,
      mint TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      side TEXT NOT NULL,
      size_sol REAL NOT NULL,
      confidence REAL,
      reason TEXT,
      llm_decision_id INTEGER,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS decision_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at_ms INTEGER NOT NULL,
      batch_id INTEGER,
      trigger_candidate_id INTEGER,
      selected_candidate_id INTEGER,
      selected_mint TEXT,
      mode TEXT NOT NULL,
      action TEXT NOT NULL,
      verdict TEXT,
      confidence REAL,
      reason TEXT,
      guardrails_json TEXT NOT NULL,
      token_json TEXT NOT NULL,
      candidate_json TEXT NOT NULL,
      batch_json TEXT NOT NULL,
      execution_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS signal_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint TEXT NOT NULL,
      kind TEXT NOT NULL,
      at_ms INTEGER NOT NULL,
      source TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS learning_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at_ms INTEGER NOT NULL,
      window_ms INTEGER NOT NULL,
      summary_json TEXT NOT NULL,
      lessons_json TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS learning_lessons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      lesson TEXT NOT NULL,
      evidence_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS strategies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      config_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS price_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint TEXT NOT NULL,
      strategy_id TEXT NOT NULL,
      alert_type TEXT NOT NULL,
      target_price_usd REAL,
      target_mcap_usd REAL,
      target_ath_distance_percent REAL,
      candidate_json TEXT NOT NULL,
      signals_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at_ms INTEGER NOT NULL,
      triggered_at_ms INTEGER,
      expires_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_status ON price_alerts(status, expires_at_ms);
    CREATE INDEX IF NOT EXISTS idx_candidates_mint ON candidates(mint);
    CREATE INDEX IF NOT EXISTS idx_positions_status ON dry_run_positions(status);
    CREATE INDEX IF NOT EXISTS idx_trade_intents_status ON trade_intents(status);
    CREATE INDEX IF NOT EXISTS idx_decision_logs_mint ON decision_logs(selected_mint);
    CREATE INDEX IF NOT EXISTS idx_signal_events_mint ON signal_events(mint);
    CREATE INDEX IF NOT EXISTS idx_learning_lessons_status ON learning_lessons(status, created_at_ms);
  `);
  ensureColumn('candidates', 'signal_key', 'TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_candidates_signal_key ON candidates(signal_key) WHERE signal_key IS NOT NULL');
  ensureColumn('dry_run_positions', 'execution_mode', "TEXT DEFAULT 'dry_run'");
  ensureColumn('dry_run_positions', 'entry_signature', 'TEXT');
  ensureColumn('dry_run_positions', 'exit_signature', 'TEXT');
  ensureColumn('dry_run_positions', 'token_amount_raw', 'TEXT');
  ensureColumn('dry_run_positions', 'strategy_id', "TEXT DEFAULT 'sniper'");
  ensureColumn('dry_run_positions', 'partial_tp_done', 'INTEGER DEFAULT 0');
  ensureColumn('decision_logs', 'strategy_id', 'TEXT');

  // Clear stale settings on every start, then re-seed.
  const insert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  const sett = {
    agent_enabled: 'true',
    trading_mode: process.env.TRADING_MODE || 'dry_run',
    llm_candidate_pick_count: process.env.LLM_CANDIDATE_PICK_COUNT || '10',
    llm_candidate_max_age_ms: process.env.LLM_CANDIDATE_MAX_AGE_MS || String(10 * 60 * 1000),
    llm_min_confidence: '75',
    max_open_positions: process.env.MAX_OPEN_POSITIONS || '3',
    dry_run_buy_sol: '0.3',
    default_tp_percent: '200',
    default_sl_percent: '-15',
    default_trailing_enabled: 'true',
    default_trailing_percent: '20',
    min_fee_claim_sol: '0.5',
    min_mcap_usd: '7000',
    max_mcap_usd: '50000',
    min_gmgn_total_fee_sol: '10',
    min_holders: '0',
    max_top20_holder_percent: '45',
    min_saved_wallet_holders: '0',
    gmgn_request_delay_ms: process.env.GMGN_REQUEST_DELAY_MS || '2500',
    gmgn_max_retries: process.env.GMGN_MAX_RETRIES || '2',
    trending_enabled: process.env.TRENDING_ENABLED || 'true',
    trending_source: process.env.TRENDING_SOURCE || 'jupiter',
    trending_allow_degen: process.env.TRENDING_ALLOW_DEGEN || 'false',
    trending_interval: process.env.TRENDING_INTERVAL || '5m',
    trending_limit: process.env.TRENDING_LIMIT || '100',
    trending_order_by: process.env.TRENDING_ORDER_BY || 'volume',
    trending_min_volume_usd: process.env.TRENDING_MIN_VOLUME_USD || '5000',
    trending_min_swaps: process.env.TRENDING_MIN_SWAPS || '50',
    trending_max_rug_ratio: process.env.TRENDING_MAX_RUG_RATIO || '0.15',
    trending_max_bundler_rate: process.env.TRENDING_MAX_BUNDLER_RATE || '0.2',
  };
  for (const [key, value] of Object.entries(sett)) insert.run(key, value);

  // Seed default strategies from code on every start.
  db.exec('DELETE FROM strategies');
  const stratInsert = db.prepare('INSERT INTO strategies (id, name, enabled, config_json, created_at_ms) VALUES (?, ?, ?, ?, ?)');
  const ts = Date.now();

  // SNIPER — FIXED: tighter SL, earlier trailing, earlier partial TP
  // Entry filter loose (biar dapet candidate), risk management tight
  stratInsert.run('sniper', 'Sniper', 1, JSON.stringify({
    entry_mode: 'immediate',
    min_source_count: 1,
    require_fee_claim: false,
    token_age_max_ms: 43200000,
    min_mcap_usd: 7000,
    max_mcap_usd: 50000,
    min_fee_claim_sol: 0,
    min_gmgn_total_fee_sol: 1,
    min_holders: 0,
    max_top20_holder_percent: 80,
    min_saved_wallet_holders: 0,
    max_ath_distance_pct: 0,
    min_graduated_volume_usd: 0,
    trending_min_volume_usd: 500,
    trending_min_swaps: 5,
    trending_max_rug_ratio: 0.3,
    trending_max_bundler_rate: 0.35,
    position_size_sol: 0.15,
    max_open_positions: 3,
    tp_percent: 150,
    sl_percent: -18,
    trailing_enabled: true,
    trailing_percent: 12,
    partial_tp: true,
    partial_tp_at_percent: 25,
    partial_tp_sell_percent: 60,
    volume_drop_exit_percent: 70,
    max_hold_ms: 7200000,
    use_llm: true,
    llm_min_confidence: 70,
  }), ts);

  // DIP BUY
  // Buy after ATH drawdown. Partial TP, max hold 2 hours.
  stratInsert.run('dip_buy', 'Dip Buy', 0, JSON.stringify({
    entry_mode: 'wait_for_dip',
    min_source_count: 1,
    require_fee_claim: false,
    token_age_max_ms: 21600000,
    min_mcap_usd: 10000,
    max_mcap_usd: 100000,
    min_fee_claim_sol: 0,
    min_gmgn_total_fee_sol: 5,
    min_holders: 100,
    max_top20_holder_percent: 45,
    min_saved_wallet_holders: 0,
    max_ath_distance_pct: -25,
    min_graduated_volume_usd: 0,
    trending_min_volume_usd: 2000,
    trending_min_swaps: 20,
    trending_max_rug_ratio: 0.15,
    trending_max_bundler_rate: 0.2,
    position_size_sol: 0.2,
    max_open_positions: 2,
    tp_percent: 100,
    sl_percent: -35,
    trailing_enabled: true,
    trailing_percent: 30,
    partial_tp: true,
    partial_tp_at_percent: 60,
    partial_tp_sell_percent: 40,
    max_hold_ms: 7200000,
    use_llm: true,
    llm_min_confidence: 70,
  }), ts);

  // SMART MONEY
  // Follow smart wallet trails with clean holder distribution.
  stratInsert.run('smart_money', 'Smart Money', 0, JSON.stringify({
    entry_mode: 'immediate',
    min_source_count: 2,
    require_fee_claim: false,
    token_age_max_ms: 43200000,
    min_mcap_usd: 15000,
    max_mcap_usd: 300000,
    min_fee_claim_sol: 0,
    min_gmgn_total_fee_sol: 0,
    min_holders: 300,
    max_top20_holder_percent: 35,
    min_saved_wallet_holders: 0,
    max_ath_distance_pct: 0,
    min_graduated_volume_usd: 0,
    trending_min_volume_usd: 5000,
    trending_min_swaps: 50,
    trending_max_rug_ratio: 0.1,
    trending_max_bundler_rate: 0.15,
    position_size_sol: 0.2,
    max_open_positions: 3,
    tp_percent: 200,
    sl_percent: -30,
    trailing_enabled: true,
    trailing_percent: 30,
    partial_tp: true,
    partial_tp_at_percent: 100,
    partial_tp_sell_percent: 50,
    max_hold_ms: 14400000,
    use_llm: true,
    llm_min_confidence: 80,
  }), ts);

  // DEGEN
  // Rule-based, high-risk testing mode for new signals.
  stratInsert.run('degen', 'Degen', 0, JSON.stringify({
    entry_mode: 'immediate',
    min_source_count: 1,
    require_fee_claim: false,
    token_age_max_ms: 3600000,
    min_mcap_usd: 5000,
    max_mcap_usd: 50000,
    min_fee_claim_sol: 0,
    min_gmgn_total_fee_sol: 0,
    min_holders: 0,
    max_top20_holder_percent: 80,
    min_saved_wallet_holders: 0,
    max_ath_distance_pct: 0,
    min_graduated_volume_usd: 0,
    trending_min_volume_usd: 0,
    trending_min_swaps: 0,
    trending_max_rug_ratio: 0.3,
    trending_max_bundler_rate: 0.35,
    position_size_sol: 0.05,
    max_open_positions: 2,
    tp_percent: 50,
    sl_percent: -15,
    trailing_enabled: true,
    trailing_percent: 10,
    partial_tp: false,
    partial_tp_at_percent: 0,
    partial_tp_sell_percent: 0,
    max_hold_ms: 3600000,
    use_llm: false,
    llm_min_confidence: 0,
  }), ts);

  // Auto-seed smart wallets so a fresh clone is ready after npm start.
  const walletInsert = db.prepare('INSERT OR IGNORE INTO saved_wallets (label, address, created_at_ms) VALUES (?, ?, ?)');
  const wallets = [
    // Verified profitable / high-frequency wallets from Birdeye x-referencing
    ['Circle G', 'GHuZrAeoucfTebB5AqB8bMMxtKNRGmSMJbcqCGRKYBW1'],
    ['Barkin', 'Dvev3AsrBCdjQjBsKksN7aWFTEMejVNPoNwZesENSUaJ'],
    ['Boss Boss', '7sReDwqSQGVdGxFCvMWZCoZTwQbXhG4RVEocFsqst9pM'],
    ['Boo Boo', 'FXEVonEvyMgn1LZAGUnWqY3Nj1yPjScaVzzPHMM9TQ5s'],
    ['Just A', 'AJlaWHCKqiaXAJFVYMUGFkmPYA84pK2FR3PmhKji5R1m'],
    ['Blin Blin', 'CJi4JyrwH2yG1mzPBdYgSxqYyxJ5Fs4xwHmGnfQ5dNsR'],
    ['Cakes Wallet', 'CYtSfvDsp8ptQ4w3TWd4f5GsPpB9BvYiTu9BRrBDrssQ'],
    ['Capital D', 'BkFnS1FHWWqPxMjBZfTupKfRBVFdJVjPcSNpkkP3HEE7'],
    ['Cohort Y', 'EM8mR8CKK3KWNvYYDSMaPB3aPCFUXw9YRGU2gmJExESU'],
    ['Colin Talks Crypto', 'BGW4dRAn7YM6CGvkM6U6HiKqxqSMDwL4iLKsTFDCT7cf'],
    ['Crypto King', '8k7QSAs4vRMX1xCJzixNRqHt2ULJMkmEGcBZ3WWbt6Pq'],
    ['db', '3NsYJnTuGx83dq72iKEssGxqFnFPP5Qbpj18WMbaKR2h'],
    ['Deeez', '7RYLA8jRUqdYvGBgNoacPjJ9eyGMCvU6WPfPJdYNPCgA'],
    ['Degen Ape', 'DKBTBAdgNPPJBeCqL3u2FhpmheFJqFdSbmPKCj2QxFho'],
    ['Dolla Sign', 'HxkSNwHRLpx6gJNg76BuxYsBGmHJW9V7WEVQqvmj8JVf'],
    ['Double O', 'H4QKB7TJhQcQZmQrRhjSbcGPztGZqBWKPWb3BwhNSHa2'],
    ['doug', '6ZQcyGvJMb59yTzmrUnRwBYn9CyrB42ELpBCV2MvqPFV'],
    ['Dsymbol', '4wEoetCQtQfayZqCej9GHW3AXAoEGmF8g5HkPrfbjBhP'],
    ['Duke', '4Lj5MZnohGqYFWKJfFjjDKRHZkdPMRyB1Ww2mey86q2T'],
    ['Easy Peasy', '4Zfo53jP4jeWKs7iQyGYRsMRD5VQWChDT4BwdAiQYnRR'],
    ['Evan Luthra', '8X3rCJF5mStzF6QefTunq8BzPQFoAGF98aAZ1EFfTogf'],
    ['Felix Viat', 'DrEqiikKVq9NEaKSfpMDdLsMm6gGVosQ7jBgEz5B1aEe'],
    ['Flash GG', '9K5TUSyeZQQWQHUZNcj71g67MhQFnCvkpcbFXGdLkdJc'],
    ['Forever Young', 'F1zNq8FfPZDQNWmffgNqKvzV7UGx5SoFn8E8CdSS1xbk'],
    ['Fresh Prince', 'HCbdopDGGfoZDpDk68YEj11GHdYTNPFZNgCzQ6FBFPZg'],
    ['Frick', 'GNnZBaHAjkYbh1eSPrH7ZQJ1nrdRjRFcHTnHmfqMKVMJ'],
    ['Gambler Inu', '7eXAGv4rC3QAtU37WWYKWLP4qFTEJu7EFzW8dpkQHbSJ'],
    ['GM', 'Fejqnu8zrRmLN52FGxRPeE3DhD5WRiZj46xk1N4vYaPt'],
    ['Goat', '69pULZaxJqZcQ2YbhtqFuAu6LvsYiEQcwhSGDSG5BauZ'],
    ['Hedge Fund', 'GG3zf7REozjJ6wQSNMgiGyeMNj5b24NbmZhfS4RBH4Sa'],
    ['Honey Badger', '6e91Pivk3GM5T5kE5Z4P7tRPSqLcUUiHMfMKC9f42cLe'],
    ['Hulk', 'AWEPCoBYfEyCnFTSVVhQ49JCgnG7QoYRJaXCXKXZNKXb'],
    ['Icy', 'DLWn6faBamR38a3nKYFBCkLEp3qRzncHUHm2E6CcnQoo'],
    ['Influencer II', 'EABJ2dYZDFSTQdHD9y6w5aAvXWQcLmMfNAxnEdHqp9HB'],
    ['Inu', 'AyMB8dDB9L7ukTyEXYN4DGFMXdVB8FkLsxnAKHwhFpMX'],
    ['Ivan', '8KLjBbZpmYAcR8MmQ99ex6c99YwZRDfUGb8nZCCgvDAK'],
    ['Jared', 'BiDCkm9FLBqv7HZSVukB8PZosv9BDduVVrwphk1pCT4D'],
    ['Jedi', '4Fwo9Hvh3x9TFkRF3HSe4HwEBsGHBHiSo7AUmAvb4KBB'],
    ['John Cena', 'CBeRGKV4HgeY73HPnEYWFsEAMFsJqM1GQqV5JdcFK8TM'],
    ['Kanye Pump', 'G47M6UPjG4UMF1k6rnYedWmcQVv6BWwJFqXqKK99E6gs'],
    ['King Solomon', 'FkKCVyqpnQqdx1yDdYq3RPbLGh2qHbeLYAHRbzQ8Jmd5'],
    ['Lambo', '6mfhqH82Lcfm4FbP27MXtLUutAuHnjUQaRWW2BsZgw1N'],
    ['Laser 155', '4VYT4VZPDPXQvB9gjQzQWCCfKWAjb5DkaCpHBmdgSCCe'],
    ['Lemon', 'HR6vc4oFbM4qE9y2WEj4SHfNLRNB7Dqfm18e2Bq1UEhx'],
    ['Logic', '9YDcTTmmREUpy4HfoPSGvypmBmX4THwJHq5stURhAfbq'],
    ['LOOT', '3oFgUSN3F46cDwLGdY3EtyJtKXRZNyoQqknhEEkF1fja'],
    ['Lucky', 'Hqv1XmYRNLF2RkPX8QVwQqVESAEkqC7wNdmJzqH7WxCu'],
    ['Mando', 'HVSY5Ho5HvBvXiydjEFcJiSbxrRJmQjt7Pr9xPruf5Es'],
    ['Max Profit', '465ERHzQNupoDEHmYGKGT9MFWD2HGLQqGWztJF3mWVbR'],
    ['Mega Whale', 'FWznbcNX3SuMpVqjLFzxRNh1pY6Nnt4eYC3fNQBrC5Gd'],
    ['Mr. Worldwide', '2BzR7yCNUM7u6mhLRd1hFiViDWJ8w2UZRU7xnfRFpjvk'],
    ['NEO', '2oPhbsVGSY8MyJ8fLQWMfNDFjFwdEAMyieKRbAsRGfXN'],
    ['Niner W', 'CgQDMFSwfPS7M6gFVEjaH8qBKiBbxQENV21kSLGJ7DSa'],
    ['Noble D', 'BX6Qk5P4wQfnsXyqJm8MqKjREmFqhYjQRRh5Wp3zVxFu'],
    ['Nugs', '9MhQ5wZT3T4MGBQpSoMpyQwFn4EzB6jXf6FR9F5kzqkN'],
    ['Obi', 'EoFkk8K3jydRXfWQTVjMdeqUL3Am25PqU3BMhVykJPsQ'],
    ['Old Money', '3snjMWB3eGRsNCF9pauQK2Pn1LFbBgoNxUNtrfQxNxAs'],
    ['Omega', 'B9RPWxhUef9y3LgAAnDCWfVd5pm46KDUWAZ9V4avBM1r'],
    ['Paper Hands', '53kJjUKSGTVFsqW4YK6EUfnP2NqAnPDdA5x6UTexUgnK'],
    ['Pepe', 'FwH3TRpaR4KRHJ55eCKgPhrSk1xqEWJWNsxBsAd8MSdN'],
    ['Pepe II', 'FeYSD6LqHBDQVtQfsqgWqL1GqQ83aTnXQmYksWqL9CjW'],
    ['Poker Face', '3teFptMMhbVQpW9NAq8gmCVqhXw1MJr89SNP1iYMSQqB'],
    ['Ponzi', 'A51PozKxadMdFU8ihVFVJVaZttK2wKDyrjKwnf7f12bn'],
    ['Pookie', '4Q1HLJdwTQyQEMFYvr2Qiw4CAJQfKTBEX6B8HPEYBGrc'],
    ['Pump ii', '57jnzAu2GWb2hEExGkMNiPsxWBbzQZFZLFSpRUDyyrGN'],
    ['Python', '9CjG5q5hK5h6wNvYtdN8WWgXvYKoNYRMG8KX3MNvAC4j'],
    ['Racer', 'Hzfsk2KDQSRfhGc2F8ZG8nJxbtPw7SMJEqQpFFZXU3iU'],
    ['Rampage', '8bWCsPmb5qxcsppdd5DdYRp1zgFZvL3NQxPxuMwiqtrw'],
    ['Rich Dad', 'e6jg2CJMhj6YvnEuoLG2KEV83H8Q62TqJiNnqH2F6nu'],
    ['Ripper', '3CJzTnxfst1ATdw2my7yQyB51PDxBbMPSFhJ1Y5a2kPc'],
    ['Rocket', '2yrqdMSysdCWFxjQxwQcJQKEJqCpYEL3LF9GmD7FEkEi'],
    ['Satoshi', '8NSTE49R2iMuQeMshvPJZTfpNSsTQ6sWPFVdPPGJWHuZ'],
    ['Savage', 'AbEogzpRDGnVMYVG1Yz3wYiEBLFXhVR3FNZAoF1itxpV'],
    ['Saylor', '5wEabk2XpKxAYp5GcMSqNw8VHWqJW4auFkLkFyYNfAFi'],
    ['Shark', 'j8MyrG5x7NYQGEsEhErAWvQSRYLZZpkEMYyZjbJg3zS'],
    ['Sheesh', 'CFqQqbs7gGfmR68kJkm7ZJNAWJBgEa15dZSj1BBQ1BWR'],
    ['Sniper', '23fB6vLYtNiuKik8Kvc1Kb6psYn9qPZSfSVGWq6zXFGb'],
    ['Sniper 2.0', 'Anc1dB8s9SFSF9FPrzMk29RMFXjJuVfPXXGqhAQjyW91'],
    ['Speed', 'J9U5MKMfdYdq6BY2ZRAsDyBwRdSwGsaMvVNppibLbbhW'],
    ['Stop Loss', '9PWgzWwRW5ekPBHRMDPqk7pHM3ghFxPfRyYArG5DBscL'],
    ['Super Saiyan', 'ETxLp77EF3bRTJBmbyo1gBNwRifRuaqPNDJYCr8dkE3M'],
    ['The Whale', '8SLrRNZFJBnt71SjAK7TzbyX2KGUefRpRcVLxYJEewom'],
    ['Titan', 'AJfaQMNM3GQJ14Czm4JhEBoCWCefdmm9kFfA99hMbzHU'],
    ['Top G', 'HL6P7GQrNptbFoFYriqxhz42Cyas5GmoYSWM1NyRnrGq'],
    ['Top Gun', 'BNpMEHxpvCTajUbyQ2Yx3PFL2w7wCs2MWS3AP4e2QKFi'],
    ['Triple', 'Eg5NYjwQG6iFUDi1x5wkjQBUBUJFoBKpXhM4NG5WPAfF'],
    ['VIP', 'BcmtYk6YsNMZ2Kuj2BzDDCvTWZ5oXVwMZuNAT6FuQU8o'],
    ['Visionary', 'GN1C2vxnkmBC54J4XhK5jSY8qM7vihxBnA9e8JcauBk3'],
    ['Wale', '6YhAWewWrqE7HKFREw5JQ4J2qerYG3nnyB1KfAD5RYjw'],
    ['Whale Alert', 'Be1wqyP9ncq5f52gtWFZTEDwfh6EmKyFzYQeA4mWgGBM'],
    ['Whale II', 'GtDgeR39B7r2CQrmqnR8A77NkcJ5XYf7GqAKGGQmLnBT'],
    ['Whale Shark', 'FdUudGQi5M9aVjMDX2Z5uKL4G6F1QdAhrm19qJBD3yBx'],
    ['Wolf', 'AxJ8JqpBnyHRj2f6AJMw5SULAC5Yt2mCmP5PStjFxK1v'],
    ['XRP Degen', 'Dm1dJ97AHnNYqN98em6o2GMb3BnSGKqstMUmyKtPFqFh'],
    ['Yoda', 'GjSeYDxAgWGCAUjrJMWMGn2JvJNXEX6XkH2oPQHV5Li8'],
    ['Zero', 'HMtrv61bQYjBuz9RoUH9ud3Y2LMBcguqWgYq8DPkGHgw'],
  ];
  for (const [label, address] of wallets) walletInsert.run(label, address, ts);
  console.log(`[db] seeded ${wallets.length} smart wallets`);

}

export function ensureColumn(table, column, ddl) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
