'use strict';
/* ============================================================================
   Valuefin Desk — internal lending operations API
   Node + Express + MySQL · http://localhost:4001

   Borrowers → drawdowns → payments run through the ported engine (calc.js);
   the ledger, MIS and dashboard are derived from that activity. Documents
   upload into per-borrower server folders and go through Director approval.
   Every state change is written to the audit trail.
   ========================================================================== */
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const config = require('./config');
const db = require('./db/pool');
const auth = require('./auth');
const { H } = require('./http');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const { router: borrowerRoutes } = require('./routes/borrowers');
const drawdownRoutes = require('./routes/drawdowns');
const paymentRoutes = require('./routes/payments');
const reportRoutes = require('./routes/reports');
const { router: documentRoutes, uploadHandler, CATEGORIES } = require('./routes/documents');
const notificationRoutes = require('./routes/notifications');
const adminRoutes = require('./routes/admin');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

/* ---------------- middleware ---------------- */
app.use(helmet({
  contentSecurityPolicy: false,          // API only; the SPA sets its own policy
  crossOriginResourcePolicy: { policy: 'cross-origin' },  // let :3000 embed the PDF stream
  crossOriginEmbedderPolicy: false
}));
app.use(cors({ origin: config.corsOrigin, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(cookieParser());
app.use(rateLimit({ windowMs: 60 * 1000, limit: 600, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests — slow down for a moment.' } }));

/* one-line request log, skipping the notification poll so it stays readable */
if (config.env !== 'test') {
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/notifications/unread-count')) return next();
    const t0 = Date.now();
    res.on('finish', () => {
      const line = res.statusCode + ' ' + req.method + ' ' + req.originalUrl + ' · ' + (Date.now() - t0) + 'ms';
      if (res.statusCode >= 500) console.error('[api] ' + line);
      else if (res.statusCode >= 400) console.warn('[api] ' + line);
      else console.log('[api] ' + line);
    });
    next();
  });
}

app.use(auth.attachUser);

/* ---------------- health ---------------- */
app.get('/api/health', H(async () => {
  let database = 'up';
  try { await db.ping(); } catch (e) {
    console.error('[health] database ping failed:', e.message);
    database = config.env === 'production' ? 'down' : 'down: ' + e.message;
  }
  return { ok: database === 'up', service: 'valuefin-desk', version: require('../package.json').version, database, ts: new Date().toISOString() };
}));
app.get('/api/meta', H(async (req) => {
  auth.requireUser(req);
  return { documentCategories: CATEGORIES, roles: ['director', 'manager', 'analyst'], uploadMaxBytes: config.uploadMaxBytes };
}));

/* ---------------- routes ---------------- */
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/borrowers', borrowerRoutes);
app.post('/api/borrowers/:id/documents', uploadHandler);   // upload scoped to a borrower
app.use('/api/drawdowns', drawdownRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/uw', require('./routes/uw'));                 // Phase 1 underwriting
app.use('/api', reportRoutes);                              // /ledger /mis /portfolio /search /audit

app.use('/api', (req, res) => res.status(404).json({ error: 'No such endpoint: ' + req.method + ' ' + req.path }));

/* ---------------- errors ---------------- */
app.use((err, _req, res, _next) => {
  let status = err.status || 500;
  let message = err.message || 'Server error';

  if (err.code === 'LIMIT_FILE_SIZE') { status = 400; message = 'That PDF is too large (max 25 MB).'; }
  else if (err.code === 'ER_DUP_ENTRY') { status = 400; message = 'That record already exists.'; }
  else if (err.code === 'ER_NO_REFERENCED_ROW_2') { status = 400; message = 'A referenced record no longer exists — refresh and try again.'; }
  else if (err.code === 'ECONNREFUSED' || err.code === 'PROTOCOL_CONNECTION_LOST') {
    status = 503; message = 'The database is unavailable. Check that MySQL is running.';
  }

  if (status >= 500) { console.error('[api] unhandled:', err); message = config.env === 'production' ? 'Server error' : message; }
  res.status(status).json({ error: message });
});

/* ---------------- boot ---------------- */
async function start() {
  const { execSync, spawnSync } = require('child_process');
  const migrate = require('./db/migrate');

  async function tryPing(retries = 6, delayMs = 2000) {
    for (let i = 0; i < retries; i++) {
      try { await db.ping(); return true; } catch (e) { if (i === retries - 1) throw e; await new Promise((r) => setTimeout(r, delayMs)); }
    }
    return false;
  }

  try {
    await db.ping();
  } catch (e) {
    console.error('\n[boot] Cannot reach MySQL at ' + config.db.host + ':' + config.db.port + ' — ' + e.message);
    if (process.platform === 'win32') {
      console.error('[boot] Install MySQL Server for Windows, then start its service (usually:  Start-Service MySQL80)');
      console.error('[boot] Then create the schema with:  npm run db:migrate\n');
      process.exit(1);
    }

    // Try to start MySQL automatically on macOS / Homebrew.
    if (process.platform === 'darwin') {
      try {
        console.log('[boot] Attempting to start MySQL via `brew services start mysql`');
        spawnSync('brew', ['services', 'start', 'mysql'], { stdio: 'inherit' });
      } catch (err) {
        console.warn('[boot] Failed to invoke brew — please start MySQL manually');
      }

      try {
        await tryPing(10, 2000);
      } catch (err) {
        console.error('[boot] MySQL did not become reachable after attempting to start it: ' + err.message);
        console.error('[boot] Start it with:  brew services start mysql');
        console.error('[boot] Then create the schema with:  npm run db:migrate\n');
        process.exit(1);
      }
    } else {
      console.error('[boot] Start it with:  brew services start mysql');
      console.error('[boot] Then create the schema with:  npm run db:migrate\n');
      process.exit(1);
    }
  }

  // At this point the DB is reachable — ensure schema and seeds are applied.
  try {
    console.log('[boot] Ensuring database schema and seed data are present');
    // Call migration entry-points programmatically where possible.
    await migrate.ensureDatabase();
    await migrate.applySchema();
    await migrate.ensureDocumentChecklistColumn();
    await migrate.applyUnderwriting();
    console.log('[boot] ' + await migrate.protectAuditLog());
    // run seed via the seed module so messages are returned and logged
    const { seed } = require('./db/seed');
    const report = await seed();
    report.forEach((line) => console.log('[seed] ' + line));
    const { seedUnderwriting } = require('./uw/seed');
    (await seedUnderwriting()).forEach((line) => console.log('[seed] ' + line));
  } catch (err) {
    console.error('[boot] Failed to apply schema/seed:', err.message);
    console.error('[boot] You can run: npm run db:migrate');
    process.exit(1);
  }

  const tables = await db.q(
    'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ? AND table_name = \'users\'',
    [config.db.database]);
  if (!tables[0].n) {
    console.error('\n[boot] The `users` table is missing — run:  npm run db:migrate\n');
    process.exit(1);
  }

  fs.mkdirSync(config.paths.customers, { recursive: true });
  await auth.purgeExpiredSessions();
  setInterval(() => auth.purgeExpiredSessions().catch(() => {}), 30 * 60 * 1000).unref();

  const server = app.listen(config.port, config.host, () => {
    console.log('');
    console.log('  Valuefin Desk API');
    console.log('  ─────────────────────────────────────────────');
    console.log('  listening   http://' + config.host + ':' + config.port);
    console.log('  database    ' + config.db.user + '@' + config.db.host + ':' + config.db.port + '/' + config.db.database);
    console.log('  cors origin ' + config.corsOrigin);
    console.log('  environment ' + config.env);
    console.log('');
  });

  /* A busy port is the most common start-up failure — usually another copy of
     this server still running — so say that rather than dumping a stack trace. */
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error('\n[boot] Port ' + config.port + ' is already in use — another Valuefin Desk API is probably running.');
      console.error('[boot] Find it with:   lsof -ti:' + config.port);
      console.error('[boot] Stop it with:   lsof -ti:' + config.port + ' | xargs kill');
      console.error('[boot] Or run this one elsewhere by setting PORT in backend/.env\n');
    } else if (err.code === 'EACCES') {
      console.error('\n[boot] Not allowed to bind port ' + config.port + '. Pick a port above 1024 in backend/.env\n');
    } else {
      console.error('\n[boot] Could not start the server:', err.message, '\n');
    }
    process.exit(1);
  });

  const shutdown = (signal) => async () => {
    console.log('\n[shutdown] ' + signal + ' — closing');
    server.close(async () => { await db.close().catch(() => {}); process.exit(0); });
    setTimeout(() => process.exit(1), 8000).unref();
  };
  process.on('SIGINT', shutdown('SIGINT'));
  process.on('SIGTERM', shutdown('SIGTERM'));
}

if (require.main === module) start();

module.exports = app;
