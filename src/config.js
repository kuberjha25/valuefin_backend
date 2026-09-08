'use strict';
/* Environment configuration. Loaded once, validated at boot so a bad setup
   fails immediately with a readable message rather than at first query. */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const int = (v, d) => (v == null || v === '' ? d : parseInt(v, 10));
const str = (v, d) => (v == null || v === '' ? d : String(v));

const config = {
  env: str(process.env.NODE_ENV, 'development'),
  port: int(process.env.PORT, 4001),
  corsOrigin: str(process.env.CORS_ORIGIN, 'http://localhost:3000'),
  db: {
    host: str(process.env.DB_HOST, '127.0.0.1'),
    port: int(process.env.DB_PORT, 3306),
    user: str(process.env.DB_USER, 'valuefin_app'),
    password: str(process.env.DB_PASSWORD, ''),
    database: str(process.env.DB_NAME, 'valuefin'),
    poolSize: int(process.env.DB_POOL_SIZE, 10)
  },
  sessionTtlHours: int(process.env.SESSION_TTL_HOURS, 12),
  bcryptRounds: int(process.env.BCRYPT_ROUNDS, 12),
  seedPasswords: {
    director: str(process.env.SEED_DIRECTOR_PASSWORD, ''),
    manager: str(process.env.SEED_MANAGER_PASSWORD, ''),
    analyst: str(process.env.SEED_ANALYST_PASSWORD, '')
  },
  paths: {
    data: path.join(__dirname, '..', 'data'),
    customers: path.join(__dirname, '..', 'data', 'customers')
  },
  uploadMaxBytes: 25 * 1024 * 1024
};

const missing = [];
if (!config.db.password) missing.push('DB_PASSWORD');
if (!config.db.database) missing.push('DB_NAME');
if (missing.length) {
  console.error('\n[config] Missing required environment values: ' + missing.join(', '));
  console.error('[config] Copy backend/.env.example to backend/.env and fill it in.\n');
  process.exit(1);
}

module.exports = config;
