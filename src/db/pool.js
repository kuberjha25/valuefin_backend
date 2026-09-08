'use strict';
/* MySQL connection pool + the two helpers the whole app uses:
     q(sql, params)  — run a query, get rows
     tx(fn)          — run fn inside a transaction with a dedicated connection

   decimalNumbers keeps DECIMAL columns as JS numbers (all magnitudes here are
   far below 2^53), and dateStrings keeps DATE/DATETIME as plain strings so no
   timezone conversion can shift a business date by a day. */
const mysql = require('mysql2/promise');
const config = require('../config');

const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  waitForConnections: true,
  connectionLimit: config.db.poolSize,
  queueLimit: 0,
  charset: 'utf8mb4_unicode_ci',
  decimalNumbers: true,
  dateStrings: true,
  namedPlaceholders: false,
  multipleStatements: false,
  timezone: 'Z'
});

async function q(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

async function one(sql, params = []) {
  const rows = await q(sql, params);
  return rows[0] || null;
}

async function tx(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const cx = {
      q: async (sql, params = []) => { const [rows] = await conn.query(sql, params); return rows; },
      one: async (sql, params = []) => { const [rows] = await conn.query(sql, params); return rows[0] || null; }
    };
    const result = await fn(cx);
    await conn.commit();
    return result;
  } catch (err) {
    try { await conn.rollback(); } catch (_) { /* connection already gone */ }
    throw err;
  } finally {
    conn.release();
  }
}

async function ping() {
  const conn = await pool.getConnection();
  try { await conn.ping(); } finally { conn.release(); }
}

async function close() { await pool.end(); }

module.exports = { pool, q, one, tx, ping, close };
