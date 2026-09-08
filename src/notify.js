'use strict';
/* In-app notifications. Addressed either to one user or to a whole role
   (every Director sees a "needs review" item, not just one of them). */
const { q } = require('./db/pool');

async function notify({ toUserId = null, toRole = null, type = '', message = '', docId = null, borrowerId = null, customerName = null }) {
  try {
    const r = await q(
      `INSERT INTO notifications (to_user_id, to_role, type, message, doc_id, borrower_id, customer_name)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [toUserId, toRole, type, String(message).slice(0, 500), docId, borrowerId, customerName]
    );
    return r.insertId;
  } catch (e) {
    console.error('[notify] failed:', e.message);
    return null;
  }
}

module.exports = { notify };
