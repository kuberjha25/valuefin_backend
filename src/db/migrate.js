'use strict';
/* ============================================================================
   Migration + seed runner.  `npm run db:migrate`

   Idempotent: creates the database if absent, applies schema.sql (all DDL is
   CREATE TABLE IF NOT EXISTS), then seeds the three staff accounts and the PML
   reference borrower only when those tables are still empty. Safe to re-run.

   `npm run db:reset` drops and rebuilds from scratch.
   ========================================================================== */
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const config = require('../config');
const { seed } = require('./seed');

const SCHEMA = path.join(__dirname, 'schema.sql');

async function rawConnection(withDatabase) {
  return mysql.createConnection({
    host: config.db.host, port: config.db.port,
    user: config.db.user, password: config.db.password,
    database: withDatabase ? config.db.database : undefined,
    multipleStatements: true, dateStrings: true, decimalNumbers: true
  });
}

async function ensureDatabase() {
  const conn = await mysql.createConnection({
    host: config.db.host, port: config.db.port, user: config.db.user, password: config.db.password
  });
  try {
    await conn.query('CREATE DATABASE IF NOT EXISTS `' + config.db.database +
      '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
  } catch (e) {
    // The app user may not hold CREATE DATABASE. That is fine when the DBA has
    // already provisioned the schema — surface it only if the DB is missing.
    const [rows] = await conn.query('SHOW DATABASES LIKE ?', [config.db.database]);
    if (!rows.length) throw e;
  } finally { await conn.end(); }
}

async function applySchema() {
  const sql = fs.readFileSync(SCHEMA, 'utf8');
  const conn = await rawConnection(true);
  try { await conn.query(sql); } finally { await conn.end(); }
}

/* schema.sql only CREATEs — a table that already exists from before this
   column existed needs an explicit ALTER to catch up. Checked against
   information_schema so it is safe to run on every migrate. */
async function ensureDocumentChecklistColumn() {
  const conn = await rawConnection(true);
  try {
    const [rows] = await conn.query(
      `SELECT COUNT(*) AS n FROM information_schema.columns
        WHERE table_schema = ? AND table_name = 'documents' AND column_name = 'checklist_key'`,
      [config.db.database]);
    if (rows[0].n) return;
    await conn.query('ALTER TABLE documents ADD COLUMN checklist_key VARCHAR(40) NULL AFTER category');
    await conn.query('ALTER TABLE documents ADD KEY ix_doc_checklist (borrower_id, checklist_key)');
  } finally { await conn.end(); }
}

/* Phase 1 underwriting tables (all CREATE TABLE IF NOT EXISTS). */
const UW_SCHEMA = path.join(__dirname, 'underwriting.sql');
async function applyUnderwriting() {
  const sql = fs.readFileSync(UW_SCHEMA, 'utf8');
  const conn = await rawConnection(true);
  try { await conn.query(sql); } finally { await conn.end(); }
}

/* Make the audit trail append-only at the database level (spec §11). Needs
   the TRIGGER privilege (and, with binary logging on, SUPER or
   log_bin_trust_function_creators); without them the app still never
   modifies audit rows, and a warning says the database-level guard is off. */
async function protectAuditLog() {
  const conn = await rawConnection(true);
  try {
    const [rows] = await conn.query(
      `SELECT trigger_name AS t FROM information_schema.triggers
        WHERE trigger_schema = ? AND event_object_table = 'audit_log'`, [config.db.database]);
    const have = new Set(rows.map((r) => r.t));
    const make = [
      ['audit_log_no_update', 'BEFORE UPDATE'],
      ['audit_log_no_delete', 'BEFORE DELETE']
    ];
    for (const [name, when] of make) {
      if (have.has(name)) continue;
      await conn.query('CREATE TRIGGER `' + name + '` ' + when + " ON audit_log FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_log is append-only'");
    }
    return 'audit_log: append-only triggers in place';
  } catch (e) {
    return 'audit_log: WARNING — could not install append-only triggers (' + e.message + ')';
  } finally { await conn.end(); }
}

async function dropAll() {
  const conn = await rawConnection(true);
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    const [rows] = await conn.query(
      'SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ?', [config.db.database]);
    for (const r of rows) await conn.query('DROP TABLE IF EXISTS `' + r.t + '`');
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  } finally { await conn.end(); }
}

async function main() {
  const reset = process.argv.includes('--reset');
  const t0 = Date.now();
  console.log('[migrate] target ' + config.db.user + '@' + config.db.host + ':' + config.db.port + '/' + config.db.database);

  await ensureDatabase();
  if (reset) { console.log('[migrate] --reset : dropping every table'); await dropAll(); }
  await applySchema();
  await ensureDocumentChecklistColumn();
  await applyUnderwriting();
  console.log('[migrate] schema applied');
  console.log('[migrate] ' + await protectAuditLog());

  const report = await seed();
  report.forEach((line) => console.log('[seed] ' + line));
  const { seedUnderwriting } = require('../uw/seed');
  (await seedUnderwriting()).forEach((line) => console.log('[seed] ' + line));

  console.log('[migrate] done in ' + (Date.now() - t0) + 'ms');
  const { close } = require('./pool');
  await close();
}

if (require.main === module) {
  main().catch((e) => { console.error('[migrate] FAILED:', e.message); process.exit(1); });
}

module.exports = { ensureDatabase, applySchema, dropAll, ensureDocumentChecklistColumn, applyUnderwriting, protectAuditLog };
