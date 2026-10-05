-- ============================================================================
-- Valuefin Desk — Phase 1 underwriting schema (ValueFin Phase 1 specification)
--
-- Kept apart from the lending-operations tables on purpose: an underwriting
-- case never creates a borrower, a drawdown or a disbursement instruction. It
-- ends in a sanction record and nothing else (spec §1, §9).
--
-- Conventions
--   * Money is BIGINT integer paise. The raw source value and its original
--     unit are kept beside it (spec §3).
--   * Facts are never overwritten. A correction is a new row that supersedes
--     the old one (supersedes_id / superseded_by_id).
--   * Every reference to a file points at an immutable document version,
--     stored content-addressed by SHA-256.
--   * Formulas, reconciliation definitions and policy rules are versioned and
--     only run once approved by two distinct people (uw_approvals).
-- ============================================================================

/* ---------------- borrower and group (identity) ---------------- */
CREATE TABLE IF NOT EXISTS uw_parties (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  entity_type    VARCHAR(40)     NOT NULL DEFAULT 'company',
  legal_name     VARCHAR(190)    NOT NULL,
  cin            VARCHAR(24)     NOT NULL DEFAULT '',
  pan            VARCHAR(10)     NOT NULL DEFAULT '',
  gstin          VARCHAR(15)     NOT NULL DEFAULT '',
  aliases        JSON            NULL,
  directors      JSON            NULL,
  related        JSON            NULL,
  identity_state ENUM('unverified','matched','mismatch','manual_review') NOT NULL DEFAULT 'unverified',
  identity_note  VARCHAR(500)    NOT NULL DEFAULT '',
  created_by_id  BIGINT UNSIGNED NULL,
  created_by     VARCHAR(120)    NOT NULL DEFAULT '',
  created_at     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_uwp_name (legal_name),
  KEY ix_uwp_pan (pan),
  KEY ix_uwp_gstin (gstin)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

/* ---------------- products (drive the checklist) ---------------- */
CREATE TABLE IF NOT EXISTS uw_products (
  product_key VARCHAR(40)  NOT NULL,
  label       VARCHAR(120) NOT NULL,
  active      TINYINT(1)   NOT NULL DEFAULT 1,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (product_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

/* ---------------- application and facility (the case) ---------------- */
CREATE TABLE IF NOT EXISTS uw_cases (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  case_code        VARCHAR(24)     NOT NULL,
  party_id         BIGINT UNSIGNED NOT NULL,
  parent_case_id   BIGINT UNSIGNED NULL,
  product          VARCHAR(40)     NOT NULL,
  requested_paise  BIGINT          NOT NULL,
  tenor_days       INT             NOT NULL,
  purpose          TEXT            NOT NULL,
  repayment_source TEXT            NOT NULL,
  sector           VARCHAR(120)    NOT NULL DEFAULT '',
  vintage_years    DECIMAL(6,2)    NULL,
  status           ENUM('open','submitted','recommended','sent_back','approved','approved_modified','declined') NOT NULL DEFAULT 'open',
  revision         INT             NOT NULL DEFAULT 1,
  -- bumped by every change that affects analysis; a run records the value it saw
  change_seq       INT             NOT NULL DEFAULT 0,
  analyst_id       BIGINT UNSIGNED NULL,
  due_date         DATE            NULL,
  terms            JSON            NULL,
  created_by_id    BIGINT UNSIGNED NULL,
  created_by       VARCHAR(120)    NOT NULL DEFAULT '',
  created_at       DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at       DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_uwc_code (case_code),
  KEY ix_uwc_status (status, id),
  KEY ix_uwc_party (party_id),
  CONSTRAINT fk_uwc_party  FOREIGN KEY (party_id) REFERENCES uw_parties (id),
  CONSTRAINT fk_uwc_parent FOREIGN KEY (parent_case_id) REFERENCES uw_cases (id) ON DELETE SET NULL,
  CONSTRAINT fk_uwc_analyst FOREIGN KEY (analyst_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

/* ---------------- documents and immutable versions ---------------- */
CREATE TABLE IF NOT EXISTS uw_documents (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  case_id            BIGINT UNSIGNED NOT NULL,
  title              VARCHAR(255)    NOT NULL,
  current_version_id BIGINT UNSIGNED NULL,
  created_at         DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_uwd_case (case_id, id),
  CONSTRAINT fk_uwd_case FOREIGN KEY (case_id) REFERENCES uw_cases (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS uw_document_versions (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  document_id        BIGINT UNSIGNED NOT NULL,
  case_id            BIGINT UNSIGNED NOT NULL,
  version            INT             NOT NULL,
  sha256             CHAR(64)        NULL,
  original_name      VARCHAR(255)    NOT NULL,
  mime               VARCHAR(100)    NOT NULL DEFAULT '',
  detected_type      ENUM('pdf','image','xlsx','csv','zip','ole','unknown') NOT NULL DEFAULT 'unknown',
  size_bytes         BIGINT UNSIGNED NOT NULL DEFAULT 0,
  source             ENUM('upload','zip','borrower_response','public_check') NOT NULL DEFAULT 'upload',
  source_path        VARCHAR(512)    NOT NULL DEFAULT '',
  parent_version_id  BIGINT UNSIGNED NULL,
  object_uri         VARCHAR(255)    NULL,
  uploaded_by_id     BIGINT UNSIGNED NULL,
  uploaded_by        VARCHAR(120)    NOT NULL DEFAULT '',
  received_at        DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  scan_status        ENUM('clean','infected','not_scanned','error') NOT NULL DEFAULT 'not_scanned',
  scan_detail        VARCHAR(255)    NOT NULL DEFAULT '',
  intake_status      ENUM('accepted','quarantined','duplicate') NOT NULL DEFAULT 'accepted',
  duplicate_of_id    BIGINT UNSIGNED NULL,
  quarantine_reason  VARCHAR(255)    NOT NULL DEFAULT '',
  recoverable_action VARCHAR(255)    NOT NULL DEFAULT '',
  extraction_status  ENUM('pending','done','ocr_required','unreadable','not_applicable','failed') NOT NULL DEFAULT 'pending',
  extraction_detail  VARCHAR(500)    NOT NULL DEFAULT '',
  page_count         INT             NULL,
  -- classification (system-suggested, analyst-confirmed or corrected)
  doc_type           VARCHAR(48)     NOT NULL DEFAULT 'unclassified',
  audit_status       ENUM('audited','unaudited','provisional','not_applicable','unknown') NOT NULL DEFAULT 'unknown',
  period_start       DATE            NULL,
  period_end         DATE            NULL,
  entity_name        VARCHAR(190)    NOT NULL DEFAULT '',
  bank_account_id    BIGINT UNSIGNED NULL,
  classified_by      ENUM('system','analyst') NOT NULL DEFAULT 'system',
  classification_confirmed TINYINT(1) NOT NULL DEFAULT 0,
  classified_by_id   BIGINT UNSIGNED NULL,
  classified_at      DATETIME(3)     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_uwv_doc_version (document_id, version),
  KEY ix_uwv_case (case_id, id),
  KEY ix_uwv_sha (case_id, sha256),
  CONSTRAINT fk_uwv_doc    FOREIGN KEY (document_id) REFERENCES uw_documents (id) ON DELETE CASCADE,
  CONSTRAINT fk_uwv_case   FOREIGN KEY (case_id) REFERENCES uw_cases (id) ON DELETE CASCADE,
  CONSTRAINT fk_uwv_parent FOREIGN KEY (parent_version_id) REFERENCES uw_document_versions (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

/* Page lines (PDF, with bounding box) and cells (XLSX/CSV, with coordinates). */
CREATE TABLE IF NOT EXISTS uw_evidence_units (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  case_id      BIGINT UNSIGNED NOT NULL,
  version_id   BIGINT UNSIGNED NOT NULL,
  kind         ENUM('line','cell') NOT NULL,
  page         INT             NULL,
  bbox         JSON            NULL,
  sheet        VARCHAR(100)    NULL,
  cell_ref     VARCHAR(16)     NULL,
  row_index    INT             NULL,
  col_index    INT             NULL,
  text         TEXT            NULL,
  formula      TEXT            NULL,
  merged_range VARCHAR(32)     NULL,
  number_format VARCHAR(64)    NULL,
  PRIMARY KEY (id),
  KEY ix_uwe_version (version_id, kind, page, sheet, row_index, col_index),
  CONSTRAINT fk_uwe_case    FOREIGN KEY (case_id) REFERENCES uw_cases (id) ON DELETE CASCADE,
  CONSTRAINT fk_uwe_version FOREIGN KEY (version_id) REFERENCES uw_document_versions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

/* ---------------- configurable checklist ---------------- */
CREATE TABLE IF NOT EXISTS uw_checklist_items (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  product           VARCHAR(40)     NULL,
  item_key          VARCHAR(48)     NOT NULL,
  label             VARCHAR(190)    NOT NULL,
  doc_type          VARCHAR(48)     NOT NULL,
  mandatory         TINYINT(1)      NOT NULL DEFAULT 1,
  min_vintage_years DECIMAL(6,2)    NULL,
  period_rule       ENUM('none','annual','monthly') NOT NULL DEFAULT 'none',
  periods_required  INT             NULL,
  audited_only      TINYINT(1)      NOT NULL DEFAULT 0,
  sort_order        INT             NOT NULL DEFAULT 0,
  active            TINYINT(1)      NOT NULL DEFAULT 1,
  created_at        DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_uwci (item_key, product),
  KEY ix_uwci_product (product, active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS uw_checklist_marks (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  case_id    BIGINT UNSIGNED NOT NULL,
  item_id    BIGINT UNSIGNED NOT NULL,
  state      ENUM('not_applicable') NOT NULL DEFAULT 'not_applicable',
  reason     VARCHAR(500)    NOT NULL,
  set_by_id  BIGINT UNSIGNED NULL,
  set_by     VARCHAR(120)    NOT NULL DEFAULT '',
  created_at DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_uwcm (case_id, item_id),
  CONSTRAINT fk_uwcm_case FOREIGN KEY (case_id) REFERENCES uw_cases (id) ON DELETE CASCADE,
  CONSTRAINT fk_uwcm_item FOREIGN KEY (item_id) REFERENCES uw_checklist_items (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

/* ---------------- typed facts with provenance ---------------- */
CREATE TABLE IF NOT EXISTS uw_field_codes (
  code        VARCHAR(64)  NOT NULL,
  label       VARCHAR(190) NOT NULL,
  value_type  ENUM('money','number','percent','text','date') NOT NULL,
  period_kind ENUM('flow','stock','none') NOT NULL DEFAULT 'none',
  category    VARCHAR(48)  NOT NULL DEFAULT 'other',
  description VARCHAR(500) NOT NULL DEFAULT '',
  active      TINYINT(1)   NOT NULL DEFAULT 1,
  PRIMARY KEY (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS uw_bank_accounts (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  case_id       BIGINT UNSIGNED NOT NULL,
  alias         VARCHAR(80)     NOT NULL,
  bank_name     VARCHAR(120)    NOT NULL DEFAULT '',
  account_last4 VARCHAR(4)      NOT NULL DEFAULT '',
  account_type  VARCHAR(40)     NOT NULL DEFAULT '',
  created_by    VARCHAR(120)    NOT NULL DEFAULT '',
  created_at    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_uwba (case_id, alias),
  CONSTRAINT fk_uwba_case FOREIGN KEY (case_id) REFERENCES uw_cases (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS uw_bank_statements (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  case_id           BIGINT UNSIGNED NOT NULL,
  account_id        BIGINT UNSIGNED NOT NULL,
  version_id        BIGINT UNSIGNED NOT NULL,
  period_from       DATE            NOT NULL,
  period_to         DATE            NOT NULL,
  opening_paise     BIGINT          NULL,
  closing_paise     BIGINT          NULL,
  mapping           JSON            NOT NULL,
  row_count         INT             NOT NULL DEFAULT 0,
  duplicate_count   INT             NOT NULL DEFAULT 0,
  validation_status ENUM('pass','fail','not_checkable') NOT NULL DEFAULT 'not_checkable',
  validation_detail VARCHAR(1000)   NOT NULL DEFAULT '',
  ack_note          VARCHAR(1000)   NULL,
  ack_by            VARCHAR(120)    NULL,
  ack_at            DATETIME(3)     NULL,
  created_by_id     BIGINT UNSIGNED NULL,
  created_by        VARCHAR(120)    NOT NULL DEFAULT '',
  created_at        DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_uwbs_case (case_id, account_id),
  CONSTRAINT fk_uwbs_case    FOREIGN KEY (case_id) REFERENCES uw_cases (id) ON DELETE CASCADE,
  CONSTRAINT fk_uwbs_account FOREIGN KEY (account_id) REFERENCES uw_bank_accounts (id) ON DELETE CASCADE,
  CONSTRAINT fk_uwbs_version FOREIGN KEY (version_id) REFERENCES uw_document_versions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS uw_transactions (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  case_id         BIGINT UNSIGNED NOT NULL,
  account_id      BIGINT UNSIGNED NOT NULL,
  statement_id    BIGINT UNSIGNED NOT NULL,
  version_id      BIGINT UNSIGNED NOT NULL,
  sheet           VARCHAR(100)    NULL,
  row_index       INT             NOT NULL,
  value_date      DATE            NOT NULL,
  amount_paise    BIGINT          NOT NULL,
  direction       ENUM('credit','debit') NOT NULL,
  balance_paise   BIGINT          NULL,
  raw_narration   VARCHAR(1000)   NOT NULL DEFAULT '',
  reference       VARCHAR(120)    NOT NULL DEFAULT '',
  dedup_key       CHAR(64)        NOT NULL,
  duplicate_of_id BIGINT UNSIGNED NULL,
  category        VARCHAR(32)     NOT NULL DEFAULT 'unknown',
  category_source ENUM('none','rule','auto_transfer','analyst') NOT NULL DEFAULT 'none',
  category_rule_id BIGINT UNSIGNED NULL,
  is_return       TINYINT(1)      NOT NULL DEFAULT 0,
  counterparty    VARCHAR(190)    NOT NULL DEFAULT '',
  transfer_pair_id BIGINT UNSIGNED NULL,
  classified_by_id BIGINT UNSIGNED NULL,
  classified_by   VARCHAR(120)    NOT NULL DEFAULT '',
  classified_at   DATETIME(3)     NULL,
  PRIMARY KEY (id),
  KEY ix_uwt_case (case_id, account_id, value_date),
  KEY ix_uwt_dedup (case_id, dedup_key),
  CONSTRAINT fk_uwt_case      FOREIGN KEY (case_id) REFERENCES uw_cases (id) ON DELETE CASCADE,
  CONSTRAINT fk_uwt_account   FOREIGN KEY (account_id) REFERENCES uw_bank_accounts (id) ON DELETE CASCADE,
  CONSTRAINT fk_uwt_statement FOREIGN KEY (statement_id) REFERENCES uw_bank_statements (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS uw_bank_rules (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  pattern       VARCHAR(120)    NOT NULL,
  direction     ENUM('credit','debit','any') NOT NULL DEFAULT 'any',
  category      VARCHAR(32)     NOT NULL,
  sets_return   TINYINT(1)      NOT NULL DEFAULT 0,
  counterparty  VARCHAR(190)    NOT NULL DEFAULT '',
  priority      INT             NOT NULL DEFAULT 100,
  active        TINYINT(1)      NOT NULL DEFAULT 1,
  created_by    VARCHAR(120)    NOT NULL DEFAULT '',
  created_at    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS uw_facts (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  case_id           BIGINT UNSIGNED NOT NULL,
  field_code        VARCHAR(64)     NOT NULL,
  value_type        ENUM('money','number','percent','text','date') NOT NULL,
  amount_paise      BIGINT          NULL,
  value_num         DECIMAL(28,6)   NULL,
  value_text        VARCHAR(1000)   NULL,
  value_date        DATE            NULL,
  currency          CHAR(3)         NULL,
  original_unit     VARCHAR(24)     NOT NULL DEFAULT '',
  raw_value         VARCHAR(255)    NOT NULL,
  period_start      DATE            NULL,
  period_end        DATE            NULL,
  basis             ENUM('audited','unaudited','provisional','management','tax_return','bank','borrower_declared','other') NOT NULL,
  source_version_id BIGINT UNSIGNED NULL,
  source_unit_id    BIGINT UNSIGNED NULL,
  source_page       INT             NULL,
  source_cell       VARCHAR(140)    NULL,
  source_txn_id     BIGINT UNSIGNED NULL,
  source_note       VARCHAR(500)    NOT NULL DEFAULT '',
  confidence        DECIMAL(5,4)    NULL,
  origin            ENUM('analyst','spreadsheet','extraction','model') NOT NULL DEFAULT 'analyst',
  review_status     ENUM('proposed','approved','provisional','rejected') NOT NULL,
  supersedes_id     BIGINT UNSIGNED NULL,
  superseded_by_id  BIGINT UNSIGNED NULL,
  is_current        TINYINT(1)      NOT NULL DEFAULT 1,
  correction_reason VARCHAR(500)    NOT NULL DEFAULT '',
  created_by_id     BIGINT UNSIGNED NULL,
  created_by        VARCHAR(120)    NOT NULL DEFAULT '',
  created_at        DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  reviewed_by_id    BIGINT UNSIGNED NULL,
  reviewed_by       VARCHAR(120)    NULL,
  reviewed_at       DATETIME(3)     NULL,
  review_note       VARCHAR(500)    NOT NULL DEFAULT '',
  PRIMARY KEY (id),
  KEY ix_uwf_case (case_id, field_code, is_current),
  CONSTRAINT fk_uwf_case    FOREIGN KEY (case_id) REFERENCES uw_cases (id) ON DELETE CASCADE,
  CONSTRAINT fk_uwf_field   FOREIGN KEY (field_code) REFERENCES uw_field_codes (code),
  CONSTRAINT fk_uwf_version FOREIGN KEY (source_version_id) REFERENCES uw_document_versions (id),
  CONSTRAINT fk_uwf_unit    FOREIGN KEY (source_unit_id) REFERENCES uw_evidence_units (id) ON DELETE SET NULL,
  CONSTRAINT fk_uwf_txn     FOREIGN KEY (source_txn_id) REFERENCES uw_transactions (id) ON DELETE SET NULL,
  CONSTRAINT fk_uwf_supersedes FOREIGN KEY (supersedes_id) REFERENCES uw_facts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

/* ---------------- Credit Logic Book: formulas, reconciliations, rules ---------------- */
CREATE TABLE IF NOT EXISTS uw_formulas (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code           VARCHAR(64)     NOT NULL,
  version        INT             NOT NULL,
  label          VARCHAR(190)    NOT NULL,
  definition     JSON            NOT NULL,
  notes          TEXT            NULL,
  status         ENUM('draft','pending_approval','approved','retired') NOT NULL DEFAULT 'draft',
  effective_from DATE            NULL,
  created_by_id  BIGINT UNSIGNED NULL,
  created_by     VARCHAR(120)    NOT NULL DEFAULT '',
  created_at     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_uwfo (code, version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS uw_recon_defs (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code                VARCHAR(64)     NOT NULL,
  version             INT             NOT NULL,
  label               VARCHAR(190)    NOT NULL,
  control_area        ENUM('revenue','debt','cash_bank','working_capital','po','integrity','other') NOT NULL,
  definition          JSON            NOT NULL,
  tolerance_pct       DECIMAL(9,4)    NULL,
  tolerance_abs_paise BIGINT          NULL,
  notes               TEXT            NULL,
  status              ENUM('draft','pending_approval','approved','retired') NOT NULL DEFAULT 'draft',
  effective_from      DATE            NULL,
  created_by_id       BIGINT UNSIGNED NULL,
  created_by          VARCHAR(120)    NOT NULL DEFAULT '',
  created_at          DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_uwrd (code, version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS uw_rules (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code           VARCHAR(64)     NOT NULL,
  version        INT             NOT NULL,
  label          VARCHAR(190)    NOT NULL,
  rule_class     ENUM('hard_stop','committee_exception','warning') NOT NULL,
  metric         VARCHAR(120)    NOT NULL,
  operator       ENUM('gt','gte','lt','lte','eq','neq','in','not_in') NOT NULL,
  threshold      JSON            NULL,
  products       JSON            NULL,
  overridable    TINYINT(1)      NOT NULL DEFAULT 0,
  test_cases     JSON            NULL,
  notes          TEXT            NULL,
  status         ENUM('draft','pending_approval','approved','retired') NOT NULL DEFAULT 'draft',
  effective_from DATE            NULL,
  effective_to   DATE            NULL,
  created_by_id  BIGINT UNSIGNED NULL,
  created_by     VARCHAR(120)    NOT NULL DEFAULT '',
  created_at     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_uwr (code, version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

/* Dual approval for every Credit Logic Book object. */
CREATE TABLE IF NOT EXISTS uw_approvals (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  object_type   ENUM('formula','recon_def','rule') NOT NULL,
  object_id     BIGINT UNSIGNED NOT NULL,
  approver_id   BIGINT UNSIGNED NOT NULL,
  approver_name VARCHAR(120)    NOT NULL,
  approver_role VARCHAR(24)     NOT NULL,
  note          VARCHAR(500)    NOT NULL DEFAULT '',
  created_at    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_uwa (object_type, object_id, approver_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

/* ---------------- deterministic runs and their outputs ---------------- */
CREATE TABLE IF NOT EXISTS uw_runs (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  case_id             BIGINT UNSIGNED NOT NULL,
  revision            INT             NOT NULL,
  trigger_reason      VARCHAR(190)    NOT NULL DEFAULT '',
  include_provisional TINYINT(1)      NOT NULL DEFAULT 0,
  input_seq           INT             NOT NULL DEFAULT 0,
  versions            JSON            NULL,
  created_by_id       BIGINT UNSIGNED NULL,
  created_by          VARCHAR(120)    NOT NULL DEFAULT 'system',
  created_at          DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_uwrun_case (case_id, id),
  CONSTRAINT fk_uwrun_case FOREIGN KEY (case_id) REFERENCES uw_cases (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS uw_calc_results (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  run_id          BIGINT UNSIGNED NOT NULL,
  case_id         BIGINT UNSIGNED NOT NULL,
  formula_id      BIGINT UNSIGNED NOT NULL,
  formula_code    VARCHAR(64)     NOT NULL,
  formula_version INT             NOT NULL,
  period_start    DATE            NULL,
  period_end      DATE            NOT NULL,
  basis           VARCHAR(24)     NOT NULL,
  status          ENUM('computed','not_computable') NOT NULL,
  provisional     TINYINT(1)      NOT NULL DEFAULT 0,
  value           DECIMAL(36,10)  NULL,
  numerator       DECIMAL(36,6)   NULL,
  denominator     DECIMAL(36,6)   NULL,
  input_fact_ids  JSON            NOT NULL,
  rationale       VARCHAR(1000)   NOT NULL DEFAULT '',
  PRIMARY KEY (id),
  KEY ix_uwcr_run (run_id),
  KEY ix_uwcr_case (case_id, formula_code),
  CONSTRAINT fk_uwcr_run  FOREIGN KEY (run_id) REFERENCES uw_runs (id) ON DELETE CASCADE,
  CONSTRAINT fk_uwcr_case FOREIGN KEY (case_id) REFERENCES uw_cases (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS uw_recon_results (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  run_id              BIGINT UNSIGNED NOT NULL,
  case_id             BIGINT UNSIGNED NOT NULL,
  def_id              BIGINT UNSIGNED NOT NULL,
  def_code            VARCHAR(64)     NOT NULL,
  def_version         INT             NOT NULL,
  period_start        DATE            NULL,
  period_end          DATE            NOT NULL,
  left_fact_ids       JSON            NOT NULL,
  right_fact_ids      JSON            NOT NULL,
  left_paise          BIGINT          NULL,
  right_paise         BIGINT          NULL,
  gap_paise           BIGINT          NULL,
  gap_pct             DECIMAL(16,6)   NULL,
  tolerance_pct       DECIMAL(9,4)    NULL,
  tolerance_abs_paise BIGINT          NULL,
  comparable_basis    VARCHAR(190)    NOT NULL DEFAULT '',
  outcome             ENUM('within_tolerance','outside_tolerance','tolerance_not_configured','not_computable') NOT NULL,
  rationale           VARCHAR(1000)   NOT NULL DEFAULT '',
  input_signature     CHAR(64)        NOT NULL,
  resolution          ENUM('none','explained','unresolved') NOT NULL DEFAULT 'none',
  explanation         TEXT            NULL,
  evidence_refs       JSON            NULL,
  resolved_by         VARCHAR(120)    NULL,
  resolved_at         DATETIME(3)     NULL,
  PRIMARY KEY (id),
  KEY ix_uwrr_run (run_id),
  KEY ix_uwrr_case (case_id, def_code),
  CONSTRAINT fk_uwrr_run  FOREIGN KEY (run_id) REFERENCES uw_runs (id) ON DELETE CASCADE,
  CONSTRAINT fk_uwrr_case FOREIGN KEY (case_id) REFERENCES uw_cases (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS uw_rule_results (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  run_id       BIGINT UNSIGNED NOT NULL,
  case_id      BIGINT UNSIGNED NOT NULL,
  rule_id      BIGINT UNSIGNED NOT NULL,
  rule_code    VARCHAR(64)     NOT NULL,
  rule_version INT             NOT NULL,
  rule_class   VARCHAR(24)     NOT NULL,
  metric       VARCHAR(120)    NOT NULL,
  metric_value VARCHAR(255)    NULL,
  outcome      ENUM('triggered','not_triggered','not_evaluable') NOT NULL,
  detail       VARCHAR(1000)   NOT NULL DEFAULT '',
  PRIMARY KEY (id),
  KEY ix_uwrl_run (run_id),
  CONSTRAINT fk_uwrl_run  FOREIGN KEY (run_id) REFERENCES uw_runs (id) ON DELETE CASCADE,
  CONSTRAINT fk_uwrl_case FOREIGN KEY (case_id) REFERENCES uw_cases (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

/* Override of a hard stop, or the reviewer + rationale a committee exception needs. */
CREATE TABLE IF NOT EXISTS uw_rule_dispositions (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  case_id       BIGINT UNSIGNED NOT NULL,
  revision      INT             NOT NULL,
  rule_code     VARCHAR(64)     NOT NULL,
  rule_version  INT             NOT NULL,
  kind          ENUM('override','exception_review') NOT NULL,
  reviewer_id   BIGINT UNSIGNED NULL,
  reviewer_name VARCHAR(120)    NOT NULL DEFAULT '',
  rationale     TEXT            NOT NULL,
  created_by_id BIGINT UNSIGNED NULL,
  created_by    VARCHAR(120)    NOT NULL DEFAULT '',
  created_at    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_uwdisp (case_id, revision, rule_code, rule_version, kind),
  CONSTRAINT fk_uwdisp_case FOREIGN KEY (case_id) REFERENCES uw_cases (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

/* ---------------- public intelligence ---------------- */
CREATE TABLE IF NOT EXISTS uw_sources (
  id                      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name                    VARCHAR(190)    NOT NULL,
  jurisdiction            VARCHAR(80)     NOT NULL DEFAULT 'India',
  url                     VARCHAR(500)    NOT NULL DEFAULT '',
  search_identifiers      VARCHAR(255)    NOT NULL DEFAULT '',
  access_method           ENUM('manual','automated') NOT NULL DEFAULT 'manual',
  automated_use_permitted TINYINT(1)      NOT NULL DEFAULT 0,
  owner                   VARCHAR(120)    NOT NULL DEFAULT '',
  refresh_date            DATE            NULL,
  fallback                VARCHAR(500)    NOT NULL DEFAULT '',
  notes                   VARCHAR(1000)   NOT NULL DEFAULT '',
  active                  TINYINT(1)      NOT NULL DEFAULT 1,
  created_at              DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS uw_public_checks (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  case_id             BIGINT UNSIGNED NOT NULL,
  source_id           BIGINT UNSIGNED NOT NULL,
  search_terms        VARCHAR(500)    NOT NULL,
  status              ENUM('pending','match_found','no_match','failed','manual_review_required') NOT NULL DEFAULT 'pending',
  searched_at         DATETIME(3)     NULL,
  query_used          VARCHAR(500)    NOT NULL DEFAULT '',
  result_url          VARCHAR(1000)   NOT NULL DEFAULT '',
  result_title        VARCHAR(500)    NOT NULL DEFAULT '',
  snapshot_version_id BIGINT UNSIGNED NULL,
  analyst_note        TEXT            NULL,
  match_confidence    ENUM('exact','probable','possible','none') NULL,
  critical            TINYINT(1)      NOT NULL DEFAULT 0,
  assigned_to_id      BIGINT UNSIGNED NULL,
  completed_by        VARCHAR(120)    NULL,
  created_by          VARCHAR(120)    NOT NULL DEFAULT '',
  created_at          DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_uwpc_case (case_id),
  CONSTRAINT fk_uwpc_case   FOREIGN KEY (case_id) REFERENCES uw_cases (id) ON DELETE CASCADE,
  CONSTRAINT fk_uwpc_source FOREIGN KEY (source_id) REFERENCES uw_sources (id),
  CONSTRAINT fk_uwpc_snap   FOREIGN KEY (snapshot_version_id) REFERENCES uw_document_versions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS uw_claims (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  case_id       BIGINT UNSIGNED NOT NULL,
  category      VARCHAR(48)     NOT NULL,
  statement     TEXT            NOT NULL,
  evidence_refs JSON            NULL,
  support_state ENUM('supported','partially_supported','unsupported','contradicted','unverified') NOT NULL DEFAULT 'unverified',
  uncertainty   VARCHAR(500)    NOT NULL DEFAULT '',
  origin        ENUM('analyst','model') NOT NULL DEFAULT 'analyst',
  created_by    VARCHAR(120)    NOT NULL DEFAULT '',
  created_at    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_uwcl_case (case_id),
  CONSTRAINT fk_uwcl_case FOREIGN KEY (case_id) REFERENCES uw_cases (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS uw_questions (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  case_id             BIGINT UNSIGNED NOT NULL,
  question            TEXT            NOT NULL,
  related_refs        JSON            NULL,
  status              ENUM('open','answered','closed') NOT NULL DEFAULT 'open',
  response            TEXT            NULL,
  response_version_id BIGINT UNSIGNED NULL,
  asked_by            VARCHAR(120)    NOT NULL DEFAULT '',
  asked_at            DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  answered_by         VARCHAR(120)    NULL,
  answered_at         DATETIME(3)     NULL,
  closed_by           VARCHAR(120)    NULL,
  closed_at           DATETIME(3)     NULL,
  PRIMARY KEY (id),
  KEY ix_uwq_case (case_id),
  CONSTRAINT fk_uwq_case FOREIGN KEY (case_id) REFERENCES uw_cases (id) ON DELETE CASCADE,
  CONSTRAINT fk_uwq_resp FOREIGN KEY (response_version_id) REFERENCES uw_document_versions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

/* ---------------- memo, snapshots and decisions ---------------- */
CREATE TABLE IF NOT EXISTS uw_memo_sections (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  case_id     BIGINT UNSIGNED NOT NULL,
  section_key VARCHAR(48)     NOT NULL,
  body        MEDIUMTEXT      NOT NULL,
  updated_by  VARCHAR(120)    NOT NULL DEFAULT '',
  updated_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_uwm (case_id, section_key),
  CONSTRAINT fk_uwm_case FOREIGN KEY (case_id) REFERENCES uw_cases (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

/* Frozen evidence + policy snapshot taken on submission. Never updated. */
CREATE TABLE IF NOT EXISTS uw_snapshots (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  case_id       BIGINT UNSIGNED NOT NULL,
  revision      INT             NOT NULL,
  payload       LONGTEXT        NOT NULL,
  sha256        CHAR(64)        NOT NULL,
  created_by_id BIGINT UNSIGNED NULL,
  created_by    VARCHAR(120)    NOT NULL DEFAULT '',
  created_at    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_uws_case (case_id, revision),
  CONSTRAINT fk_uws_case FOREIGN KEY (case_id) REFERENCES uw_cases (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS uw_decisions (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  case_id     BIGINT UNSIGNED NOT NULL,
  revision    INT             NOT NULL,
  snapshot_id BIGINT UNSIGNED NULL,
  stage       ENUM('analyst','checker','sanction','system') NOT NULL,
  action      ENUM('submit','send_back','recommend','approve','approve_modified','decline','reopen_new_evidence') NOT NULL,
  rationale   TEXT            NOT NULL,
  terms       JSON            NULL,
  actor_id    BIGINT UNSIGNED NULL,
  actor_name  VARCHAR(120)    NOT NULL DEFAULT '',
  actor_role  VARCHAR(24)     NOT NULL DEFAULT '',
  created_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_uwdec_case (case_id, id),
  CONSTRAINT fk_uwdec_case FOREIGN KEY (case_id) REFERENCES uw_cases (id) ON DELETE CASCADE,
  CONSTRAINT fk_uwdec_snap FOREIGN KEY (snapshot_id) REFERENCES uw_snapshots (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

/* ---------------- module settings ---------------- */
CREATE TABLE IF NOT EXISTS uw_settings (
  setting_key VARCHAR(64)  NOT NULL,
  value       JSON         NULL,
  updated_by  VARCHAR(120) NOT NULL DEFAULT '',
  updated_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
