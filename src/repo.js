'use strict';
/* ============================================================================
   Repository layer — the only place that knows the SQL column names.

   Rows come back snake_case from MySQL; the engine and the API speak camelCase.
   Every mapper below is the single translation point, so a schema rename never
   leaks past this file.
   ========================================================================== */
const { q } = require('./db/pool');

const num = (v) => (v == null ? 0 : +v);
const bool = (v) => !!(v === 1 || v === true || v === '1');
const iso = (v) => (v == null ? null : String(v).replace(' ', 'T'));

/* ---------------- mappers ---------------- */
const mapUser = (r) => r && ({
  id: r.id, name: r.name, email: r.email, role: r.role,
  active: bool(r.active), mustReset: bool(r.must_reset),
  lastLoginAt: iso(r.last_login_at), createdAt: iso(r.created_at)
});

const mapBorrower = (r) => r && ({
  id: r.id, slug: r.slug, name: r.name, biz: r.biz, loanType: r.loan_type,
  limit: num(r.base_limit), rate: num(r.rate), penRate: num(r.pen_rate),
  procFeePct: num(r.proc_fee_pct), gstPct: num(r.gst_pct),
  tenure: num(r.tenure), tenureUnit: r.tenure_unit, sanctionDate: r.sanction_date,
  status: r.status, contactName: r.contact_name, contactEmail: r.contact_email,
  contactPhone: r.contact_phone, pan: r.pan, gstin: r.gstin,
  isSample: bool(r.is_sample), createdBy: r.created_by,
  createdAt: iso(r.created_at), updatedAt: iso(r.updated_at)
});

const mapDrawdown = (r) => r && ({
  id: r.id, borrowerId: r.borrower_id, ref: r.ref, poAmt: num(r.po_amt),
  bankDebit: r.bank_debit, mode: r.mode, cd: r.cd == null ? null : num(r.cd), ad: num(r.ad),
  adv: num(r.adv), feePct: num(r.fee_pct), fee: num(r.fee), gstAmt: num(r.gst_amt),
  disbursed: num(r.disbursed), outPrin: num(r.out_prin), intOverhang: num(r.int_overhang),
  intCollected: num(r.int_collected), loanType: r.loan_type, status: r.status, rem: r.rem,
  rotatedFrom: r.rotated_from, createdBy: r.created_by, createdAt: iso(r.created_at)
});

const mapPayment = (r) => r && ({
  id: r.id, borrowerId: r.borrower_id, drawdownId: r.drawdown_id, ref: r.ref,
  date: r.pay_date, amount: num(r.amount), intAdj: num(r.int_adj), prinAdj: num(r.prin_adj),
  outAfter: num(r.out_after), closed: bool(r.closed), kind: r.kind, rem: r.rem,
  createdBy: r.created_by, createdAt: iso(r.created_at)
});

const mapLimit = (r) => r && ({
  id: r.id, borrowerId: r.borrower_id, date: r.event_date, incrAmt: num(r.incr_amt),
  note: r.note, createdBy: r.created_by, createdAt: iso(r.created_at)
});

const mapDocument = (r) => r && ({
  id: r.id, borrowerId: r.borrower_id, borrowerName: r.borrower_name || null,
  title: r.title, filename: r.filename, storedName: r.stored_name, relPath: r.rel_path,
  size: num(r.size_bytes), category: r.category, checklistKey: r.checklist_key || null,
  uploadedById: r.uploaded_by_id, uploadedBy: r.uploaded_by, uploadedAt: iso(r.uploaded_at),
  status: r.status, decidedBy: r.decided_by, decidedAt: iso(r.decided_at), reason: r.reason,
  hasFile: !!r.rel_path
});

const mapNotification = (r) => r && ({
  id: r.id, to: r.to_user_id, toRole: r.to_role, type: r.type, message: r.message,
  docId: r.doc_id, borrowerId: r.borrower_id, customerName: r.customer_name,
  read: bool(r.is_read), createdAt: iso(r.created_at)
});

const mapAudit = (r) => r && ({
  id: r.id, userId: r.user_id, userName: r.user_name, role: r.role, action: r.action,
  entity: r.entity, entityId: r.entity_id, summary: r.summary,
  detail: typeof r.detail === 'string' ? safeJson(r.detail) : r.detail,
  ip: r.ip, createdAt: iso(r.created_at)
});
function safeJson(s) { try { return JSON.parse(s); } catch (_) { return null; } }

/* ---------------- engine store loader ----------------
   Builds the in-memory shape calc.js expects. Scoped to one borrower when an
   id is given, so a borrower page never pulls the whole book. */
async function loadEngineStore(opts = {}, run = q) {
  const bid = opts.borrowerId != null ? +opts.borrowerId : null;
  const where = bid ? ' WHERE borrower_id = ?' : '';
  const args = bid ? [bid] : [];
  const [borrowers, drawdowns, payments, limitHistory] = await Promise.all([
    run(bid ? 'SELECT * FROM borrowers WHERE id = ?' : 'SELECT * FROM borrowers ORDER BY name', args),
    run('SELECT * FROM drawdowns' + where + ' ORDER BY bank_debit, id', args),
    run('SELECT * FROM payments' + where + ' ORDER BY pay_date, id', args),
    run('SELECT * FROM limit_history' + where + ' ORDER BY event_date, id', args)
  ]);
  return {
    borrowers: borrowers.map(mapBorrower),
    drawdowns: drawdowns.map(mapDrawdown),
    payments: payments.map(mapPayment),
    limitHistory: limitHistory.map(mapLimit)
  };
}

/* ---------------- small finders ---------------- */
const getBorrower = async (id, run = q) => mapBorrower((await run('SELECT * FROM borrowers WHERE id = ?', [id]))[0]);
const getDrawdown = async (id, run = q) => mapDrawdown((await run('SELECT * FROM drawdowns WHERE id = ?', [id]))[0]);
const getPayment = async (id, run = q) => mapPayment((await run('SELECT * FROM payments WHERE id = ?', [id]))[0]);
const getDocument = async (id, run = q) => mapDocument((await run(
  'SELECT d.*, b.name AS borrower_name FROM documents d JOIN borrowers b ON b.id = d.borrower_id WHERE d.id = ?', [id]))[0]);
const paymentsForDrawdown = async (ddId, run = q) =>
  (await run('SELECT * FROM payments WHERE drawdown_id = ? ORDER BY pay_date, id', [ddId])).map(mapPayment);

/* Persist a replay result: the drawdown's derived state plus every payment
   allocation it changed. Runs inside the caller's transaction. */
async function persistReplay(cx, drawdownId, replay) {
  await cx.q(
    'UPDATE drawdowns SET out_prin = ?, int_overhang = ?, int_collected = ?, status = ? WHERE id = ?',
    [replay.state.outPrin, replay.state.intOverhang, replay.state.intCollected, replay.state.status, drawdownId]
  );
  for (const p of replay.payments) {
    await cx.q(
      'UPDATE payments SET int_adj = ?, prin_adj = ?, out_after = ?, closed = ?, kind = ? WHERE id = ?',
      [p.intAdj, p.prinAdj, p.outAfter, p.closed ? 1 : 0, p.kind, p.id]
    );
  }
}

const slugify = (s) => String(s).toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'customer';

async function uniqueSlug(name, run = q) {
  const base = slugify(name);
  let slug = base;
  for (let i = 2; i < 500; i++) {
    const hit = await run('SELECT id FROM borrowers WHERE slug = ? LIMIT 1', [slug]);
    if (!hit.length) return slug;
    slug = base + '-' + i;
  }
  return base + '-' + Date.now();
}

module.exports = {
  mapUser, mapBorrower, mapDrawdown, mapPayment, mapLimit, mapDocument, mapNotification, mapAudit,
  loadEngineStore, getBorrower, getDrawdown, getPayment, getDocument, paymentsForDrawdown,
  persistReplay, slugify, uniqueSlug
};
