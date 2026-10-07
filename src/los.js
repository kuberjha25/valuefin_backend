'use strict';
/* ============================================================================
   Origination model — turning a credit_applications row (plus its receivables,
   deviations and filed documents) into the object the screens read, and the
   stage rules that keep a file where it belongs.

   Stages, in the order a file moves through them:
     Docs Pending → Policy Check → CAM → CAM Pending → Approved → Sanctioned → Disbursed
   with Declined reachable from anywhere before Sanctioned.
   ========================================================================== */
const { q } = require('./db/pool');
const repo = require('./repo');
const policy = require('./policy');
const settings = require('./settings');
const { notFound } = require('./http');

const STAGES = ['Docs Pending', 'Policy Check', 'CAM', 'CAM Pending', 'Approved', 'Declined', 'Sanctioned', 'Disbursed'];
const SETTLED = ['Sanctioned', 'Disbursed'];
const num = (v) => (v == null ? 0 : +v);
const iso = (v) => (v == null ? null : String(v).replace(' ', 'T'));
const dateOnly = (v) => (v == null ? null : String(v).slice(0, 10));

const CAM_KEYS = ['pdNotes', 'bizMgmt', 'repaymentTools', 'finAssessment', 'risks', 'conditionsPrecedent'];

/* ---------------- document checklist rows ---------------- */
function checklistRows(row, checklists) {
  const seen = new Set();
  const out = [];
  const push = (r, extra) => {
    if (seen.has(r.key)) return;
    seen.add(r.key);
    out.push({ key: r.key, label: r.label, mandatory: !!r.mandatory, extra: !!extra });
  };
  (checklists.common || []).forEach((r) => push(r));
  (checklists[row.product] || []).forEach((r) => push(r));
  (repo.json(row.extra_rows, []) || []).forEach((r) => push(r, true));
  return out;
}

/* ---------------- row → API object ---------------- */
function mapDeviation(d) {
  if (!d) return null;
  const controls = repo.json(d.controls, []) || [];
  return {
    id: d.id, n: d.n, status: d.status, reason: d.reason || '',
    compensating: [controls.join('; '), d.note || ''].filter(Boolean).join(controls.length && d.note ? ' — ' : ''),
    controls, note: d.note || '',
    raisedBy: d.raised_by, raisedById: d.raised_by_id, ts: iso(d.raised_at),
    decidedBy: d.decided_by || null, decidedAt: iso(d.decided_at),
    checkerComment: d.checker_comment || '', pricingBump: num(d.pricing_bump)
  };
}

function mapReceivable(r) {
  return {
    id: r.id, kind: r.kind, number: r.number, buyer: r.buyer || '', value: num(r.value),
    date: dateOnly(r.doc_date), dueDate: dateOnly(r.due_date), documentId: r.document_id || null, createdBy: r.created_by
  };
}

function mapApplication(r, ctx) {
  const P = policy.PRODUCTS[r.product];
  const rows = checklistRows(r, ctx.checklists);
  const live = ctx.docs.filter((d) => d.status !== 'rejected');
  const documents = rows.map((row) => {
    const hit = live.filter((d) => d.docKey === row.key).sort((a, b) => b.id - a.id)[0];
    return { ...row, status: hit ? 'uploaded' : 'pending', documentId: hit ? hit.id : null };
  });
  const missingDocs = documents.filter((d) => d.mandatory && d.status !== 'uploaded').length;

  const rateIn = repo.json(r.rate_build, {}) || {};
  const rateBuild = {
    qAdj: num(rateIn.qAdj), sAdj: num(rateIn.sAdj), qComment: rateIn.qComment || '', sComment: rateIn.sComment || '',
    tenorComment: rateIn.tenorComment || '',
    final: rateIn.saved ? +(P.floor + num(rateIn.qAdj) + num(rateIn.sAdj)).toFixed(2) : 0
  };

  const devs = ctx.devs.map(mapDeviation);
  const latestDev = devs.length ? devs[devs.length - 1] : null;
  const camIn = repo.json(r.cam, null);
  const cam = camIn || {};
  const receivables = ctx.recv.map(mapReceivable);

  return {
    id: r.id, appCode: r.app_code, legalName: r.legal_name, entityType: r.entity_type, sector: r.sector,
    product: r.product, productName: P.name, requestedAmount: num(r.requested_amount),
    tenureValue: num(r.tenure_value), tenureUnit: r.tenure_unit, tenorDays: num(r.tenor_days),
    purpose: r.purpose || '', repaymentSource: r.repayment_source || '',
    promoterName: r.promoter_name, promoterMobile: r.promoter_mobile, companyPan: r.company_pan, gstin: r.gstin,
    vcs: repo.json(r.vcs, []) || [],
    stage: r.stage, declineReason: r.decline_reason || '',
    borrowerId: r.borrower_id || null,
    createdBy: r.created_by, createdById: r.created_by_id, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
    eligibility: repo.json(r.eligibility, {}) || {},
    rate: rateBuild,
    policyCheck: repo.json(r.policy_check, null),
    deviation: latestDev, devCount: devs.length, deviations: devs,
    cam, sanction: repo.json(r.sanction, null),
    documents, missingDocs,
    files: ctx.docs.map((d) => ({
      id: d.id, title: d.title, docKey: d.docKey, category: d.category, uploadedBy: d.uploadedBy, uploadedAt: d.uploadedAt,
      status: d.status, analysis: d.analysis || null, size: d.size
    })),
    receivables, receivableTotal: receivables.reduce((s, p) => s + p.value, 0)
  };
}

/* Everything that hangs off a set of applications, fetched in four queries
   rather than four per file. */
async function hydrate(rows, { fullAnalysis = false } = {}) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [checklists, recv, devs, docs] = await Promise.all([
    settings.getChecklists(),
    q('SELECT * FROM application_receivables WHERE application_id IN (?) ORDER BY id', [ids]),
    q('SELECT * FROM application_deviations WHERE application_id IN (?) ORDER BY n, id', [ids]),
    q((fullAnalysis ? repo.DOCUMENT_SELECT_FULL : repo.DOCUMENT_SELECT) + ' WHERE d.application_id IN (?) ORDER BY d.id', [ids])
  ]);
  const group = (list, key) => list.reduce((m, x) => ((m[x[key]] = m[x[key]] || []).push(x), m), {});
  const rByApp = group(recv, 'application_id'), dByApp = group(devs, 'application_id'), fByApp = group(docs, 'application_id');
  return rows.map((r) => mapApplication(r, {
    checklists,
    recv: rByApp[r.id] || [],
    devs: dByApp[r.id] || [],
    docs: (fByApp[r.id] || []).map((d) => repo.mapDocument(d, { full: fullAnalysis }))
  }));
}

async function getApplication(id) {
  const rows = await q('SELECT * FROM credit_applications WHERE id = ?', [id]);
  if (!rows.length) return null;
  return (await hydrate(rows, { fullAnalysis: true }))[0];
}
async function requireApplication(id) {
  const a = await getApplication(id);
  if (!a) throw notFound('Application not found.');
  return a;
}
async function getRow(id) {
  const rows = await q('SELECT * FROM credit_applications WHERE id = ?', [id]);
  if (!rows.length) throw notFound('Application not found.');
  return rows[0];
}

async function listApplications({ term, stage, product } = {}) {
  const where = [], args = [];
  if (stage) { where.push('stage = ?'); args.push(stage); }
  if (product) { where.push('product = ?'); args.push(product); }
  if (term) {
    where.push('(legal_name LIKE ? OR app_code LIKE ? OR company_pan LIKE ? OR promoter_name LIKE ?)');
    const like = '%' + term + '%';
    args.push(like, like, like, like);
  }
  const rows = await q('SELECT * FROM credit_applications' + (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY updated_at DESC, id DESC', args);
  return hydrate(rows);
}

/* A file moves from Docs Pending to Policy Check by itself once the last
   mandatory row is filed, and drops back if a mandatory row appears or a
   filed document is rejected or removed — but never once the CAM has started. */
async function refreshStage(applicationId) {
  const a = await getApplication(applicationId);
  if (!a) return null;
  let next = a.stage;
  if (a.stage === 'Docs Pending' && a.missingDocs === 0) next = 'Policy Check';
  else if (a.stage === 'Policy Check' && a.missingDocs > 0) next = 'Docs Pending';
  if (next !== a.stage) {
    await q('UPDATE credit_applications SET stage = ? WHERE id = ?', [next, applicationId]);
    a.stage = next;
  }
  return a;
}

const nextCode = (id, when = new Date()) => 'APP-' + when.getFullYear() + '-' + String(id).padStart(4, '0');

module.exports = {
  STAGES, SETTLED, CAM_KEYS, checklistRows, mapApplication, mapDeviation, mapReceivable,
  hydrate, getApplication, requireApplication, getRow, listApplications, refreshStage, nextCode
};
