import Database from 'better-sqlite3';
const db = new Database('./charon.sqlite');

// Strategy in use
const strat = db.prepare('SELECT * FROM strategies WHERE enabled=1').get();
console.log('=== STRATEGY ACTIVE ===');
console.log('ID:', strat.id, 'Name:', strat.name);
console.log('Config:', JSON.stringify(JSON.parse(strat.config_json), null, 2));

// Recent candidates
console.log('\n=== RECENT CANDIDATES ===');
const cands = db.prepare('SELECT id, mint, status, created_at_ms, candidate_json, filter_result_json FROM candidates ORDER BY id DESC LIMIT 10').all();
cands.forEach(r => {
  const c = JSON.parse(r.candidate_json);
  const f = JSON.parse(r.filter_result_json);
  const ageMin = Math.round((c.metrics?.tokenAgeMs || 0) / 60000);
  console.log(`\nID:${r.id} | ${r.mint.slice(0,8)} | ${r.status} | ${c.token?.symbol || '?'} | mcap:$${Math.round(c.metrics?.marketCapUsd || 0).toLocaleString()} | holders:${c.metrics?.holderCount || 0} | age:${ageMin}m`);
  if (!f.passed) console.log('  FILTER FAILS:', f.failures.join('; '));
  else console.log('  FILTER: PASSED');
});

// Signals
console.log('\n=== SIGNALS ===');
const sigs = db.prepare("SELECT kind, COUNT(*) as c FROM signal_events GROUP BY kind").all();
sigs.forEach(s => console.log(s.kind, s.c));

// Decision logs
console.log('\n=== DECISION LOGS ===');
const dlogs = db.prepare("SELECT action, COUNT(*) as c FROM decision_logs GROUP BY action").all();
dlogs.forEach(d => console.log(d.action, d.c));

// Positions
console.log('\n=== POSITIONS ===');
const posTotal = db.prepare('SELECT COUNT(*) as c FROM dry_run_positions').get().c;
const posOpen = db.prepare("SELECT COUNT(*) as c FROM dry_run_positions WHERE status='open'").get().c;
const posClosed = db.prepare("SELECT COUNT(*) as c FROM dry_run_positions WHERE status='closed'").get().c;
console.log(`Total: ${posTotal} | Open: ${posOpen} | Closed: ${posClosed}`);

// LLM Decisions
console.log('\n=== LLM DECISIONS ===');
const lld = db.prepare("SELECT verdict, COUNT(*) as c FROM llm_decisions GROUP BY verdict").all();
lld.forEach(l => console.log(l.verdict, l.c));

// Settings
console.log('\n=== KEY SETTINGS ===');
const sets = db.prepare("SELECT key, value FROM settings WHERE key IN ('trading_mode','agent_enabled','max_open_positions','dry_run_buy_sol','default_tp_percent','default_sl_percent','llm_min_confidence')").all();
sets.forEach(s => console.log(s.key, '=', s.value));
