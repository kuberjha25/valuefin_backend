'use strict';
/* The cross-cutting views: everything waiting on a checker, and the queue counts
   behind the sidebar badges. Neither owns any data — they read what the other
   modules wrote. */
const express = require('express');
const { q } = require('../db/pool');
const repo = require('../repo');
const calc = require('../calc');
const auth = require('../auth');
const policy = require('../policy');
const { H } = require('../http');

const router = express.Router();
const iso = (v) => (v == null ? null : String(v).replace(' ', 'T'));
const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

router.get('/approvals', H(async (req) => {
  auth.requireUser(req);
  const [cams, devs, docs, disb, enh, ren, recent] = await Promise.all([
    q("SELECT id, app_code, legal_name, product, requested_amount, cam FROM credit_applications WHERE stage = 'CAM Pending'"),
    q(`SELECT d.*, a.app_code, a.legal_name FROM application_deviations d JOIN credit_applications a ON a.id = d.application_id WHERE d.status = 'pending'`),
    q(repo.DOCUMENT_SELECT + " WHERE d.status = 'pending'"),
    q(`SELECT r.*, b.name AS borrower_name FROM disbursement_requests r JOIN borrowers b ON b.id = r.borrower_id WHERE r.status = 'pending'`),
    q(`SELECT e.*, b.name AS borrower_name FROM limit_enhancements e JOIN borrowers b ON b.id = e.borrower_id WHERE e.status = 'pending'`),
    q(`SELECT c.*, b.name AS borrower_name FROM renewal_cases c JOIN borrowers b ON b.id = c.borrower_id WHERE c.status = 'pending'`),
    q("SELECT * FROM audit_log WHERE action REGEXP '\\\\.(approved|rejected|declined)$' ORDER BY id DESC LIMIT 15")
  ]);

  const pending = [];
  cams.forEach((a) => {
    const cam = repo.json(a.cam, {}) || {};
    pending.push({ ref: 'cam-' + a.id, kind: 'CAM', title: a.app_code + ' · ' + a.legal_name,
      detail: policy.PRODUCTS[a.product].name + ' · ' + policy.inrShort(+a.requested_amount) + ' requested',
      raisedBy: cam.submittedBy || '', ts: cam.submittedAt || null, link: '/applications/' + a.id });
  });
  devs.forEach((d) => pending.push({ ref: 'dev-' + d.id, kind: 'Deviation', title: 'Deviation ' + d.n + ' of 2 · ' + d.app_code + ' · ' + d.legal_name,
    detail: clip(d.reason, 140), raisedBy: d.raised_by, ts: iso(d.raised_at), link: '/applications/' + d.application_id }));
  docs.map((r) => repo.mapDocument(r)).forEach((d) => pending.push({ ref: 'doc-' + d.id, kind: 'Document', title: d.title,
    detail: (d.ownerName || 'Unfiled') + ' · ' + d.category, raisedBy: d.uploadedBy, ts: d.uploadedAt, link: '/documents' }));
  disb.forEach((r) => pending.push({ ref: 'disb-' + r.id, kind: 'Disbursement', title: r.borrower_name + ' · ' + policy.inrShort(+r.amount) + ' payout',
    detail: (r.kind === 'rotation' ? 'Rotation' : 'Fresh drawdown') + ' · value date ' + String(r.value_date).slice(0, 10), raisedBy: r.raised_by,
    ts: iso(r.raised_at), link: '/disbursements' }));
  enh.forEach((e) => pending.push({ ref: 'enh-' + e.id, kind: 'Enhancement', title: e.borrower_name + ' · limit to ' + policy.inrShort(+e.new_limit),
    detail: 'from ' + policy.inrShort(+e.from_limit) + (e.board_flag ? ' · Board level' : ''), raisedBy: e.raised_by, ts: iso(e.raised_at), link: '/enhancement' }));
  ren.forEach((c) => pending.push({ ref: 'ren-' + c.id, kind: 'Renewal', title: c.borrower_name + ' · renewal to ' + String(c.new_expiry).slice(0, 10),
    detail: 'rate ' + +c.current_rate + '% → ' + +c.new_rate + '%', raisedBy: c.raised_by, ts: iso(c.raised_at), link: '/renewals' }));
  pending.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));

  return { pending, recent: recent.map(repo.mapAudit) };
}));

router.get('/nav-badges', H(async (req) => {
  const me = auth.requireUser(req);
  const c = async (sql, args = []) => +((await q(sql, args))[0].n || 0);
  const today = calc.td();
  const store = await repo.loadEngineStore();
  const byId = new Map(store.borrowers.map((b) => [b.id, b]));

  const rotation = store.drawdowns.filter((d) => {
    if (d.status === 'Repaid') return false;
    const b = byId.get(d.borrowerId);
    return b && (calc.poAccrued(d, b, today).odD > 0 || calc.di(today, calc.dueDate(d, b)) - 1 <= 14) && d.loanType !== 'io';
  }).length;
  const renewals = store.borrowers.filter((b) => { const r = calc.renewalStatus(store, b.id); return r && r.daysLeft <= 45; }).length;

  const [camPending, devPending, docsPending, disbPending, disbApproved, enhPending, renPending, ewsOpen, applications] = await Promise.all([
    c("SELECT COUNT(*) AS n FROM credit_applications WHERE stage = 'CAM Pending'"),
    c("SELECT COUNT(*) AS n FROM application_deviations WHERE status = 'pending'"),
    c("SELECT COUNT(*) AS n FROM documents WHERE status = 'pending'"),
    c("SELECT COUNT(*) AS n FROM disbursement_requests WHERE status = 'pending'"),
    c("SELECT COUNT(*) AS n FROM disbursement_requests WHERE status = 'approved'"),
    c("SELECT COUNT(*) AS n FROM limit_enhancements WHERE status = 'pending'"),
    c("SELECT COUNT(*) AS n FROM renewal_cases WHERE status = 'pending'"),
    c("SELECT COUNT(*) AS n FROM ews_alerts WHERE status = 'open'"),
    c("SELECT COUNT(*) AS n FROM credit_applications WHERE stage IN ('Docs Pending','Policy Check','CAM','CAM Pending','Approved')")
  ]);

  const isDirector = me.role === 'director';
  return {
    approvals: camPending + devPending + docsPending + disbPending + enhPending + renPending,
    applications,
    rotation,
    // Pending is the Director's to act on; approved is Accounts' to pay.
    disbursements: me.role === 'accounts' ? disbApproved : (isDirector ? disbPending + disbApproved : disbPending),
    enhancement: enhPending,
    renewals: renewals + renPending,
    ews: ewsOpen,
    documents: docsPending
  };
}));

module.exports = router;
