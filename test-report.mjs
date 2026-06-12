import { db } from './src/db/connection.js';
import { now } from './src/utils.js';

function print(label, value) {
  console.log(`\n━━ ${label} ━━`);
  console.log(value ?? '(kosong / null)');
}

try {
  // 1. Semua posisi apa adanya
  const allPositions = db.prepare(`
    SELECT id, mint, symbol, status, opened_at_ms, closed_at_ms,
           entry_mcap, exit_mcap, pnl_percent, pnl_sol, size_sol,
           exit_reason, execution_mode, strategy_id
    FROM dry_run_positions
    ORDER BY id DESC
  `).all();
  print(`Total posisi: ${allPositions.length}`, allPositions.length
    ? allPositions.map(p => `  #${p.id} | ${p.symbol ?? p.mint?.slice(0,8)} | ${p.status} | mode=${p.execution_mode} | entry=${p.entry_mcap} | pnl=${p.pnl_percent}% | reason=${p.exit_reason ?? '-'}`).join('\n')
    : 'Belum ada posisi sama sekali.');

  // 2. Semua trade (buy/sell)
  const allTrades = db.prepare(`
    SELECT id, position_id, side, reason, at_ms, mcap, size_sol
    FROM dry_run_trades
    ORDER BY id DESC
  `).all();
  print(`Total trade: ${allTrades.length}`, allTrades.length
    ? allTrades.map(t => `  #${t.id} | pos=${t.position_id} | ${t.side} | reason=${t.reason} | mcap=${t.mcap} | size=${t.size_sol}`).join('\n')
    : 'Belum ada trade sama sekali.');

  // 3. Ringkasan closed posisi
  const closed = allPositions.filter(p => p.status === 'closed');
  const wins = closed.filter(p => Number(p.pnl_percent || 0) > 0).length;
  const losses = closed.filter(p => Number(p.pnl_percent || 0) < 0).length;
  const totalPnlSol = closed.reduce((sum, p) => sum + Number(p.pnl_sol || 0), 0);
  print('Closed Summary', `Closed: ${closed.length} | Wins: ${wins} | Losses: ${losses} | Total PnL SOL: ${totalPnlSol.toFixed(6)}`);

  // 4. Posisi yang masih OPEN (jika ada)
  const open = allPositions.filter(p => p.status === 'open');
  print(`Open positions: ${open.length}`, open.length
    ? open.map(p => `  #${p.id} | ${p.symbol ?? p.mint?.slice(0,8)} | entry=${p.entry_mcap} | high=${p.high_water_mcap} | pnl=${p.pnl_percent}%`).join('\n')
    : 'Tidak ada posisi terbuka.');

  // 5. Settings penting
  const settings = db.prepare(`SELECT key, value FROM settings WHERE key IN ('trading_mode','agent_enabled','max_open_positions','dry_run_buy_sol','default_tp_percent','default_sl_percent')`).all();
  print('Key Settings', settings.map(s => `  ${s.key} = ${s.value}`).join('\n'));

  // 6. Strategi aktif
  const strat = db.prepare(`SELECT * FROM strategies WHERE enabled = 1 LIMIT 1`).get();
  print('Active Strategy', strat ? `  ${strat.id} | tp=${strat.tp_percent}% | sl=${strat.sl_percent}% | size=${strat.position_size_sol} SOL | max_pos=${strat.max_open_positions} | trailing=${strat.trailing_enabled}` : 'Tidak ada strategi aktif!');

  // 7. Cek apakah monitorPositions pernah error (dari log tidak bisa dibaca di sini, tapi cek posisi stale)
  if (open.length > 0) {
    const oldestOpen = open.reduce((a, b) => a.opened_at_ms < b.opened_at_ms ? a : b);
    const hoursOpen = (now() - oldestOpen.opened_at_ms) / (1000 * 60 * 60);
    print('Stale Check', `Posisi tertua terbuka: ${hoursOpen.toFixed(1)} jam yang lalu (ID #${oldestOpen.id}).`);
    if (hoursOpen > 24 && !oldestOpen.trailing_armed) {
      console.log('\n⚠️  WARNING: Ada posisi terbuka >24 jam tanpa trailing armed. Bisa jadi monitorPositions tidak jalan.');
    }
  }
} catch (err) {
  console.error('ERROR:', err.message);
}
