'use strict';
/* ============================================================================
   Underwriting repository — the only place that knows the uw_* column names.
   Rows come back snake_case; the API speaks camelCase. Money stays in integer
   paise end to end (field names end in "Paise").
   ========================================================================== */
const { q } = require('../db/pool');

const iso = (v) => (v == null ? null : String(v).replace(' ', 'T'));
const bool = (v) => v === 1 || v === true || v === '1';
const n = (v) => (v == null ? null : Number(v));
function j(v) {
  if (v == null) return null;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch (_) { return null; }
}
const js = (v) => (v == null ? null : JSON.stringify(v));

const mapParty = (r) => r && ({
  id: r.id, entityType: r.entity_type, legalName: r.legal_name, cin: r.cin, pan: r.pan, gstin: r.gstin,
  aliases: j(r.aliases) || [], directors: j(r.directors) || [], related: j(r.related) || [],
  identityState: r.identity_state, identityNote: r.identity_note,
  createdBy: r.created_by, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at)
});

const mapCase = (r) => r && ({
  id: r.id, caseCode: r.case_code, partyId: r.party_id, parentCaseId: r.parent_case_id,
  legalName: r.legal_name || undefined,
  product: r.product, requestedPaise: n(r.requested_paise), tenorDays: r.tenor_days,
  purpose: r.purpose, repaymentSource: r.repayment_source, sector: r.sector,
  vintageYears: n(r.vintage_years), status: r.status, revision: r.revision, changeSeq: r.change_seq,
  analystId: r.analyst_id, analystName: r.analyst_name || null, dueDate: r.due_date,
  terms: j(r.terms), createdById: r.created_by_id, createdBy: r.created_by,
  createdAt: iso(r.created_at), updatedAt: iso(r.updated_at)
});

const mapVersion = (r) => r && ({
  id: r.id, documentId: r.document_id, caseId: r.case_id, version: r.version, sha256: r.sha256,
  title: r.title || undefined,
  originalName: r.original_name, mime: r.mime, detectedType: r.detected_type, sizeBytes: n(r.size_bytes),
  source: r.source, sourcePath: r.source_path, parentVersionId: r.parent_version_id,
  hasObject: !!r.object_uri, uploadedBy: r.uploaded_by, uploadedById: r.uploaded_by_id, receivedAt: iso(r.received_at),
  scanStatus: r.scan_status, scanDetail: r.scan_detail, intakeStatus: r.intake_status,
  duplicateOfId: r.duplicate_of_id, quarantineReason: r.quarantine_reason, recoverableAction: r.recoverable_action,
  extractionStatus: r.extraction_status, extractionDetail: r.extraction_detail, pageCount: r.page_count,
  docType: r.doc_type, auditStatus: r.audit_status, periodStart: r.period_start, periodEnd: r.period_end,
  entityName: r.entity_name, bankAccountId: r.bank_account_id, classifiedBy: r.classified_by,
  classificationConfirmed: bool(r.classification_confirmed), classifiedAt: iso(r.classified_at),
  isCurrent: r.current_version_id != null ? r.current_version_id === r.id : undefined
});

const mapUnit = (r) => r && ({
  id: r.id, versionId: r.version_id, kind: r.kind, page: r.page, bbox: j(r.bbox), sheet: r.sheet,
  cellRef: r.cell_ref, rowIndex: r.row_index, colIndex: r.col_index, text: r.text, formula: r.formula,
  mergedRange: r.merged_range, numberFormat: r.number_format
});

const mapFact = (r) => r && ({
  id: r.id, caseId: r.case_id, fieldCode: r.field_code, fieldLabel: r.field_label || undefined,
  valueType: r.value_type, amountPaise: n(r.amount_paise),
  valueNum: r.value_num == null ? null : String(r.value_num), valueText: r.value_text, valueDate: r.value_date,
  currency: r.currency, originalUnit: r.original_unit, rawValue: r.raw_value,
  periodStart: r.period_start, periodEnd: r.period_end, basis: r.basis,
  sourceVersionId: r.source_version_id, sourceUnitId: r.source_unit_id, sourcePage: r.source_page,
  sourceCell: r.source_cell, sourceTxnId: r.source_txn_id, sourceNote: r.source_note,
  sourceName: r.source_name || undefined,
  confidence: n(r.confidence), origin: r.origin, reviewStatus: r.review_status,
  supersedesId: r.supersedes_id, supersededById: r.superseded_by_id, isCurrent: bool(r.is_current),
  correctionReason: r.correction_reason, createdBy: r.created_by, createdById: r.created_by_id,
  createdAt: iso(r.created_at), reviewedBy: r.reviewed_by, reviewedAt: iso(r.reviewed_at), reviewNote: r.review_note
});

const mapFieldCode = (r) => r && ({
  code: r.code, label: r.label, valueType: r.value_type, periodKind: r.period_kind,
  category: r.category, description: r.description, active: bool(r.active)
});

const mapApproval = (r) => r && ({ approverId: r.approver_id, approverName: r.approver_name, approverRole: r.approver_role, note: r.note, at: iso(r.created_at) });

const mapFormula = (r) => r && ({
  id: r.id, code: r.code, version: r.version, label: r.label, definition: j(r.definition), notes: r.notes || '',
  status: r.status, effectiveFrom: r.effective_from, createdBy: r.created_by, createdById: r.created_by_id, createdAt: iso(r.created_at)
});

const mapReconDef = (r) => r && ({
  id: r.id, code: r.code, version: r.version, label: r.label, controlArea: r.control_area,
  definition: j(r.definition), tolerancePct: r.tolerance_pct == null ? null : String(r.tolerance_pct),
  toleranceAbsPaise: n(r.tolerance_abs_paise), notes: r.notes || '', status: r.status,
  effectiveFrom: r.effective_from, createdBy: r.created_by, createdById: r.created_by_id, createdAt: iso(r.created_at)
});

const mapRule = (r) => r && ({
  id: r.id, code: r.code, version: r.version, label: r.label, ruleClass: r.rule_class, metric: r.metric,
  operator: r.operator, threshold: j(r.threshold), products: j(r.products), overridable: bool(r.overridable),
  testCases: j(r.test_cases) || [], notes: r.notes || '', status: r.status,
  effectiveFrom: r.effective_from, effectiveTo: r.effective_to,
  createdBy: r.created_by, createdById: r.created_by_id, createdAt: iso(r.created_at)
});

const mapCalc = (r) => r && ({
  id: r.id, runId: r.run_id, formulaId: r.formula_id, formulaCode: r.formula_code, formulaVersion: r.formula_version,
  periodStart: r.period_start, periodEnd: r.period_end, basis: r.basis, status: r.status,
  provisional: bool(r.provisional), value: r.value == null ? null : String(r.value),
  numerator: r.numerator == null ? null : String(r.numerator), denominator: r.denominator == null ? null : String(r.denominator),
  inputFactIds: j(r.input_fact_ids) || [], rationale: r.rationale
});

const mapRecon = (r) => r && ({
  id: r.id, runId: r.run_id, defId: r.def_id, defCode: r.def_code, defVersion: r.def_version,
  periodStart: r.period_start, periodEnd: r.period_end,
  leftFactIds: j(r.left_fact_ids) || [], rightFactIds: j(r.right_fact_ids) || [],
  leftPaise: n(r.left_paise), rightPaise: n(r.right_paise), gapPaise: n(r.gap_paise),
  gapPct: r.gap_pct == null ? null : String(r.gap_pct),
  tolerancePct: r.tolerance_pct == null ? null : String(r.tolerance_pct), toleranceAbsPaise: n(r.tolerance_abs_paise),
  comparableBasis: r.comparable_basis, outcome: r.outcome, rationale: r.rationale, inputSignature: r.input_signature,
  resolution: r.resolution, explanation: r.explanation, evidenceRefs: j(r.evidence_refs) || [],
  resolvedBy: r.resolved_by, resolvedAt: iso(r.resolved_at)
});

const mapRuleResult = (r) => r && ({
  id: r.id, runId: r.run_id, ruleId: r.rule_id, ruleCode: r.rule_code, ruleVersion: r.rule_version,
  ruleClass: r.rule_class, metric: r.metric, metricValue: r.metric_value, outcome: r.outcome, detail: r.detail
});

const mapDisposition = (r) => r && ({
  id: r.id, revision: r.revision, ruleCode: r.rule_code, ruleVersion: r.rule_version, kind: r.kind,
  reviewerId: r.reviewer_id, reviewerName: r.reviewer_name, rationale: r.rationale,
  createdBy: r.created_by, createdAt: iso(r.created_at)
});

const mapAccount = (r) => r && ({
  id: r.id, caseId: r.case_id, alias: r.alias, bankName: r.bank_name, accountLast4: r.account_last4,
  accountType: r.account_type, createdBy: r.created_by, createdAt: iso(r.created_at)
});

const mapStatement = (r) => r && ({
  id: r.id, accountId: r.account_id, versionId: r.version_id, periodFrom: r.period_from, periodTo: r.period_to,
  openingPaise: n(r.opening_paise), closingPaise: n(r.closing_paise), mapping: j(r.mapping),
  rowCount: r.row_count, duplicateCount: r.duplicate_count, validationStatus: r.validation_status,
  validationDetail: r.validation_detail, ackNote: r.ack_note, ackBy: r.ack_by, ackAt: iso(r.ack_at),
  createdBy: r.created_by, createdAt: iso(r.created_at)
});

const mapTxn = (r) => r && ({
  id: r.id, accountId: r.account_id, statementId: r.statement_id, versionId: r.version_id,
  sheet: r.sheet, rowIndex: r.row_index, valueDate: r.value_date, amountPaise: n(r.amount_paise),
  direction: r.direction, balancePaise: n(r.balance_paise), rawNarration: r.raw_narration, reference: r.reference,
  duplicateOfId: r.duplicate_of_id, category: r.category, categorySource: r.category_source,
  categoryRuleId: r.category_rule_id, isReturn: bool(r.is_return), counterparty: r.counterparty,
  transferPairId: r.transfer_pair_id, classifiedBy: r.classified_by, classifiedAt: iso(r.classified_at)
});

const mapBankRule = (r) => r && ({
  id: r.id, pattern: r.pattern, direction: r.direction, category: r.category, setsReturn: bool(r.sets_return),
  counterparty: r.counterparty, priority: r.priority, active: bool(r.active), createdBy: r.created_by, createdAt: iso(r.created_at)
});

const mapSource = (r) => r && ({
  id: r.id, name: r.name, jurisdiction: r.jurisdiction, url: r.url, searchIdentifiers: r.search_identifiers,
  accessMethod: r.access_method, automatedUsePermitted: bool(r.automated_use_permitted), owner: r.owner,
  refreshDate: r.refresh_date, fallback: r.fallback, notes: r.notes, active: bool(r.active)
});

const mapCheck = (r) => r && ({
  id: r.id, caseId: r.case_id, sourceId: r.source_id, sourceName: r.source_name || undefined,
  searchTerms: r.search_terms, status: r.status, searchedAt: iso(r.searched_at), queryUsed: r.query_used,
  resultUrl: r.result_url, resultTitle: r.result_title, snapshotVersionId: r.snapshot_version_id,
  analystNote: r.analyst_note, matchConfidence: r.match_confidence, critical: bool(r.critical),
  assignedToId: r.assigned_to_id, completedBy: r.completed_by, createdBy: r.created_by,
  createdAt: iso(r.created_at), updatedAt: iso(r.updated_at)
});

const mapClaim = (r) => r && ({
  id: r.id, category: r.category, statement: r.statement, evidenceRefs: j(r.evidence_refs) || [],
  supportState: r.support_state, uncertainty: r.uncertainty, origin: r.origin,
  createdBy: r.created_by, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at)
});

const mapQuestion = (r) => r && ({
  id: r.id, question: r.question, relatedRefs: j(r.related_refs) || [], status: r.status, response: r.response,
  responseVersionId: r.response_version_id, askedBy: r.asked_by, askedAt: iso(r.asked_at),
  answeredBy: r.answered_by, answeredAt: iso(r.answered_at), closedBy: r.closed_by, closedAt: iso(r.closed_at)
});

const mapDecision = (r) => r && ({
  id: r.id, revision: r.revision, snapshotId: r.snapshot_id, stage: r.stage, action: r.action,
  rationale: r.rationale, terms: j(r.terms), actorId: r.actor_id, actorName: r.actor_name,
  actorRole: r.actor_role, createdAt: iso(r.created_at)
});

/* ---------------- finders ---------------- */
async function getCase(id, run = q) {
  const rows = await run(
    `SELECT c.*, p.legal_name, u.name AS analyst_name FROM uw_cases c
       JOIN uw_parties p ON p.id = c.party_id
       LEFT JOIN users u ON u.id = c.analyst_id
      WHERE c.id = ?`, [id]);
  return mapCase(rows[0]);
}
async function getParty(id, run = q) { return mapParty((await run('SELECT * FROM uw_parties WHERE id = ?', [id]))[0]); }

async function getVersion(id, run = q) {
  const rows = await run(
    `SELECT v.*, d.title, d.current_version_id FROM uw_document_versions v
       JOIN uw_documents d ON d.id = v.document_id WHERE v.id = ?`, [id]);
  return rows[0] ? Object.assign(mapVersion(rows[0]), { objectUri: rows[0].object_uri }) : null;
}

async function getSetting(key, fallback = null, run = q) {
  const rows = await run('SELECT value FROM uw_settings WHERE setting_key = ?', [key]);
  if (!rows.length) return fallback;
  const v = j(rows[0].value);
  return v == null ? fallback : v;
}

module.exports = {
  j, js, iso, bool,
  mapParty, mapCase, mapVersion, mapUnit, mapFact, mapFieldCode, mapApproval, mapFormula, mapReconDef, mapRule,
  mapCalc, mapRecon, mapRuleResult, mapDisposition, mapAccount, mapStatement, mapTxn, mapBankRule, mapSource,
  mapCheck, mapClaim, mapQuestion, mapDecision,
  getCase, getParty, getVersion, getSetting
};
