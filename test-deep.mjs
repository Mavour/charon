import { db } from './src/db/connection.js';

function print(label, value) {
  console.log(`\n━━ ${label} ━━`);
  console.log(value ?? '(kosong / null)');
}

try {
  // 1. Cek candidates terbaru
  const candidates = db.prepare(`
    SELECT id, mint, status, created_at_ms, signature, signal_key,
           json_extract(candidate_json, '$.signals.route') as route,
           json_extract(candidate_json, '$.metrics.marketCapUsd') as mcap,
           json_extract(candidate_json, '$.token.symbol') as symbol,
           json_extract(filter_result_json, '$.passed') as passed,
           json_extract(filter_result_json, '$.failures') as failures
    FROM candidates
    ORDER BY id DESC
    LIMIT 10
  `).all();
  print(`10 Candidates terbaru:`, candidates.length
    ? candidates.map(c => `  #${c.id} | ${c.symbol ?? c.mint?.slice(0,8)} | status=${c.status} | mcap=$${Math.round(c.mcap || 0).toLocaleString()} | passed=${c.passed} | route=${c.route} | failures=${c.failures ?? 'none'}`).join('\n')
    : 'Tidak ada candidates sama sekali.');

  // 2. Cek decisions / batch
  const decisions = db.prepare(`
    SELECT id, candidate_id, verdict, confidence, created_at_ms,
           json_extract(raw_json, '$.selected_candidate_id') as selected_id,
           reason
    FROM llm_decisions
    ORDER BY id DESC
    LIMIT 10
  `).all();
  print(`10 Decisions terbaru:`, decisions.length
    ? decisions.map(d => `  #${d.id} | cand=${d.candidate_id} | verdict=${d.verdict} | conf=${Math.round(d.confidence)}% | sel=${d.selected_id} | reason=${d.reason?.slice(0,60)}...`).join('\n')
    : 'Tidak ada decisions sama sekali.');

  // 3. Cek batch decisions
  const batches = db.prepare(`
    SELECT id, verdict, confidence, created_at_ms,
           selected_candidate_id, selected_mint, reason
    FROM llm_batches
    ORDER BY id DESC
    LIMIT 5
  `).all();
  print(`5 Batch decisions:`, batches.length
    ? batches.map(b => `  #${b.id} | verdict=${b.verdict} | conf=${Math.round(b.confidence)}% | sel=${b.selected_candidate_id} | mint=${b.selected_mint?.slice(0,8)}`).join('\n')
    : 'Tidak ada batch sama sekali.');

  // 4. Cek decision logs (event terpenting)
  const logs = db.prepare(`
    SELECT action, COUNT(*) as count
    FROM decision_logs
    GROUP BY action
    ORDER BY count DESC
  `).all();
  print(`Decision logs summary:`, logs.length
    ? logs.map(l => `  ${l.action}: ${l.count}x`).join('\n')
    : 'Tidak ada logs sama sekali.');

  // 5. Cek signal events
  const signals = db.prepare(`
    SELECT kind, COUNT(*) as count, MAX(at_ms) as last_ms
    FROM signal_events
    GROUP BY kind
    ORDER BY count DESC
  `).all();
  print(`Signal events:`, signals.length
    ? signals.map(s => `  ${s.kind}: ${s.count}x | terakhir=${new Date(s.last_ms).toISOString()}`).join('\n')
    : 'Tidak ada signal events sama sekali.');

  // 6. Cek jumlah candidate per status
  const byStatus = db.prepare(`SELECT status, COUNT(*) as count FROM candidates GROUP BY status`).all();
  print(`Candidate by status:`, byStatus.map(s => `  ${s.status}: ${s.count}`).join('\n'));

  // 7. Cek alert
  const alerts = db.prepare(`SELECT kind, COUNT(*) as count FROM alerts GROUP BY kind`).all();
  print(`Alerts:`, alerts.length ? alerts.map(a => `  ${a.kind}: ${a.count}`).join('\n') : 'Tidak ada alerts sama sekali.');

  // 8. Cek apakah ada enriched candidate yang failed
  const recentFiltered = db.prepare(`
    SELECT id, mint, status, json_extract(filter_result_json, '$.failures') as failures
    FROM candidates
    WHERE json_extract(filter_result_json, '$.passed') = 0
    ORDER BY id DESC
    LIMIT 5
  `).all();
  print(`5 Kandidat terakhir yang GAGAL filter:`, recentFiltered.length
    ? recentFiltered.map(c => `  #${c.id} | ${c.mint?.slice(0,8)} | ${c.failures}`).join('\n')
    : 'Belum ada yang gagal filter (atau belum ada kandidat).');

  // 9. Cek max positions check
  const openCount = db.prepare(`SELECT COUNT(*) as count FROM dry_run_positions WHERE status = 'open'`).get();
  const maxPos = db.prepare(`SELECT value FROM settings WHERE key = 'max_open_positions'`).get();
  print(`Position check:`, `Open: ${openCount.count} / Max: ${maxPos?.value ?? '?'}`);

  // 10. Cek trade intents
  const intents = db.prepare(`SELECT status, COUNT(*) as count FROM trade_intents GROUP BY status`).all();
  print(`Trade intents:`, intents.length ? intents.map(i => `  ${i.status}: ${i.count}`).join('\n') : 'Tidak ada trade intents.');

} catch (err) {
  console.error('ERROR:', err.message);
}
