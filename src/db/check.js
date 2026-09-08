'use strict';
/* `npm run db:check` — prove the connection, list the tables and their row
   counts, and confirm the engine agrees with what is stored. Useful as the
   first thing to run when something looks wrong. */
const config = require('../config');
const { q, close } = require('./pool');
const repo = require('../repo');
const calc = require('../calc');

async function main() {
  console.log('\n  Valuefin Desk — database check');
  console.log('  ' + config.db.user + '@' + config.db.host + ':' + config.db.port + '/' + config.db.database);

  const [{ v }] = await q('SELECT VERSION() AS v');
  console.log('  server      MySQL ' + v);

  const tables = await q(
    `SELECT table_name AS name, table_rows AS approx FROM information_schema.tables
      WHERE table_schema = ? ORDER BY table_name`, [config.db.database]);
  if (!tables.length) { console.log('\n  No tables — run: npm run db:migrate\n'); return; }

  console.log('\n  table              rows');
  console.log('  ─────────────────────────');
  for (const t of tables) {
    const [{ n }] = await q('SELECT COUNT(*) AS n FROM `' + t.name + '`');
    console.log('  ' + t.name.padEnd(18) + String(n).padStart(5));
  }

  const store = await repo.loadEngineStore();
  const p = calc.portfolio(store);
  console.log('\n  portfolio as at ' + p.asOf);
  console.log('  ─────────────────────────');
  console.log('  sanctioned   ' + p.sanctioned.toLocaleString('en-IN'));
  console.log('  outstanding  ' + p.outstanding.toLocaleString('en-IN'));
  console.log('  income       ' + p.incomeBooked.toLocaleString('en-IN'));
  console.log('  accrued open ' + p.accruedOpen.toLocaleString('en-IN'));

  // Every drawdown's stored state should equal a replay of its own payments.
  let drift = 0;
  for (const d of store.drawdowns) {
    const b = store.borrowers.find((x) => x.id === d.borrowerId);
    const r = calc.replayDrawdown(d, b, store.payments.filter((x) => x.drawdownId === d.id));
    if (Math.abs(r.state.outPrin - d.outPrin) > 0.5 || r.state.status !== d.status) {
      drift++;
      console.log('  ! drift on drawdown ' + d.id + ': stored ' + d.outPrin + '/' + d.status +
        ' vs replay ' + r.state.outPrin + '/' + r.state.status);
    }
  }
  console.log('\n  integrity    ' + (drift ? drift + ' drawdown(s) out of sync' : 'all ' + store.drawdowns.length + ' drawdowns reconcile'));
  console.log('');
}

main().then(close).catch((e) => { console.error('\n  FAILED: ' + e.message + '\n'); process.exit(1); });
