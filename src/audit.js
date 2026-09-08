'use strict';
/* Append-only activity trail. Every state-changing route writes one row.
   Audit failures are logged but never break the operation that succeeded. */
const { q } = require('./db/pool');
const { clientIp } = require('./auth');

async function log(req, action, entity, entityId, summary, detail) {
  try {
    const u = req.user || {};
    await q(
      `INSERT INTO audit_log (user_id, user_name, role, action, entity, entity_id, summary, detail, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [u.id || null, u.name || 'system', u.role || '', action, entity || '',
        entityId == null ? null : String(entityId), String(summary || '').slice(0, 500),
        detail ? JSON.stringify(detail) : null, clientIp(req)]
    );
  } catch (e) {
    console.error('[audit] failed to record "' + action + '":', e.message);
  }
}

module.exports = { log };
