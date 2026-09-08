'use strict';
/* In-app notifications for the signed-in user: anything addressed to them
   directly, plus anything addressed to their role. */
const express = require('express');
const { q } = require('../db/pool');
const repo = require('../repo');
const auth = require('../auth');
const { H, reqId } = require('../http');

const router = express.Router();
const MINE = '(n.to_user_id = ? OR n.to_role = ?)';

router.get('/', H(async (req) => {
  const u = auth.requireUser(req);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const rows = await q(
    'SELECT n.* FROM notifications n WHERE ' + MINE + ' ORDER BY n.id DESC LIMIT ' + limit, [u.id, u.role]);
  const [{ unread }] = await q(
    'SELECT COUNT(*) AS unread FROM notifications n WHERE ' + MINE + ' AND n.is_read = 0', [u.id, u.role]);
  return { items: rows.map(repo.mapNotification), unread: +unread };
}));

router.get('/unread-count', H(async (req) => {
  const u = auth.requireUser(req);
  const [{ unread }] = await q(
    'SELECT COUNT(*) AS unread FROM notifications n WHERE ' + MINE + ' AND n.is_read = 0', [u.id, u.role]);
  return { unread: +unread };
}));

router.post('/:id/read', H(async (req) => {
  const u = auth.requireUser(req);
  const id = reqId(req.params.id, 'Notification');
  await q('UPDATE notifications n SET n.is_read = 1 WHERE n.id = ? AND ' + MINE, [id, u.id, u.role]);
  return { ok: true };
}));

router.post('/read-all', H(async (req) => {
  const u = auth.requireUser(req);
  const r = await q('UPDATE notifications n SET n.is_read = 1 WHERE ' + MINE + ' AND n.is_read = 0', [u.id, u.role]);
  return { ok: true, marked: r.affectedRows };
}));

router.delete('/:id', H(async (req) => {
  const u = auth.requireUser(req);
  const id = reqId(req.params.id, 'Notification');
  await q('DELETE FROM notifications n WHERE n.id = ? AND n.to_user_id = ?', [id, u.id]);
  return { ok: true };
}));

module.exports = router;
