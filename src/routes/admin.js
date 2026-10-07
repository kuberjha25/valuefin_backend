'use strict';
/* Administration — data reset and system status. Director only. */
const fs = require('fs');
const path = require('path');
const express = require('express');
const config = require('../config');
const { q, tx } = require('../db/pool');
const auth = require('../auth');
const audit = require('../audit');
const { seedReferenceBorrower } = require('../db/seed');
const { H, bad } = require('../http');

const router = express.Router();

router.get('/status', H(async (req) => {
  auth.requireUser(req);
  const [counts] = await q(`
    SELECT (SELECT COUNT(*) FROM borrowers) AS borrowers,
           (SELECT COUNT(*) FROM drawdowns) AS drawdowns,
           (SELECT COUNT(*) FROM payments)  AS payments,
           (SELECT COUNT(*) FROM documents) AS documents,
           (SELECT COUNT(*) FROM credit_applications) AS applications,
           (SELECT COUNT(*) FROM users WHERE active = 1) AS users,
           (SELECT COUNT(*) FROM sessions WHERE expires_at > NOW(3)) AS sessions,
           (SELECT COUNT(*) FROM audit_log) AS auditEntries`);
  const [{ v }] = await q('SELECT VERSION() AS v');
  const [size] = await q(
    `SELECT ROUND(SUM(data_length + index_length) / 1024, 1) AS kb
       FROM information_schema.tables WHERE table_schema = ?`, [config.db.database]);
  return {
    database: { name: config.db.database, host: config.db.host + ':' + config.db.port, engine: 'MySQL ' + v, sizeKb: size.kb || 0 },
    counts: Object.fromEntries(Object.entries(counts).map(([k, n]) => [k, +n])),
    server: { env: config.env, node: process.version, uptimeSec: Math.round(process.uptime()), sessionTtlHours: config.sessionTtlHours }
  };
}));

/* Wipe every business record and restore the PML reference example.
   Staff accounts and the audit trail are deliberately preserved. */
router.post('/reset', H(async (req) => {
  const me = auth.requireDirector(req);
  if (String(req.body.confirm || '').trim().toUpperCase() !== 'RESET') {
    throw bad('Type RESET to confirm — this cannot be undone.');
  }

  await tx(async (cx) => {
    await cx.q('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of ['payments', 'drawdowns', 'limit_history', 'documents', 'notifications',
      'disbursement_requests', 'limit_enhancements', 'renewal_cases', 'ews_alerts', 'site_visits', 'borrower_mis',
      'application_receivables', 'application_deviations', 'credit_applications', 'borrowers']) {
      await cx.q('TRUNCATE TABLE ' + t);
    }
    await cx.q('SET FOREIGN_KEY_CHECKS = 1');
  });

  // Clear the uploaded PDFs that those document rows pointed at.
  try {
    if (fs.existsSync(config.paths.customers)) {
      for (const entry of fs.readdirSync(config.paths.customers)) {
        fs.rmSync(path.join(config.paths.customers, entry), { recursive: true, force: true });
      }
    }
  } catch (e) { console.error('[admin] could not clear customer folders:', e.message); }

  const note = await seedReferenceBorrower();
  await audit.log(req, 'admin.reset', 'system', null, me.name + ' reset all business data to the reference example');
  return { ok: true, note };
}));

/* ---------------- backup ----------------
   The lending record, not a credentials dump: staff export without their
   password hashes, and live sessions are left behind entirely. The audit trail
   travels with it, because a record is only examinable if its history comes too. */
const BACKUP_TABLES = ['users', 'investors', 'app_settings', 'borrowers', 'limit_history', 'credit_applications', 'drawdowns', 'payments',
  'documents', 'application_receivables', 'application_deviations', 'disbursement_requests', 'limit_enhancements', 'renewal_cases',
  'ews_alerts', 'site_visits', 'borrower_mis', 'capital_funding', 'capital_parked', 'notifications', 'audit_log'];

function countFiles(dir) {
  let n = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      n += e.isDirectory() ? countFiles(p) : 1;
    }
  } catch (_) { /* no folder yet */ }
  return n;
}

router.get('/backup/preview', H(async (req) => {
  auth.requireDirector(req);
  const tables = {};
  for (const t of BACKUP_TABLES) tables[t] = +(await q('SELECT COUNT(*) AS n FROM `' + t + '`'))[0].n;
  return { tables, total: Object.values(tables).reduce((s, n) => s + n, 0), storedFiles: countFiles(config.paths.customers) };
}));

router.get('/backup', async (req, res, next) => {
  try {
    const me = auth.requireDirector(req);
    const out = {};
    for (const t of BACKUP_TABLES) {
      const cols = t === 'users' ? 'id, name, email, role, active, must_reset, last_login_at, created_at, updated_at' : '*';
      out[t] = await q('SELECT ' + cols + ' FROM `' + t + '`');
    }
    const stamp = new Date().toISOString().slice(0, 10);
    await audit.log(req, 'admin.backup', 'system', null, me.name + ' downloaded a backup of the book');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="valuefin_backup_' + stamp + '.json"');
    res.send(JSON.stringify({
      meta: { generatedAt: new Date().toISOString(), generatedBy: me.name, service: 'valuefin-desk', database: config.db.database,
        note: 'Password hashes and sessions are excluded. Uploaded PDFs live in backend/data and must be copied separately.' },
      tables: out
    }, null, 1));
  } catch (e) { next(e); }
});

module.exports = router;
