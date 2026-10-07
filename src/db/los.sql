-- ============================================================================
-- Valuefin Desk — origination (LOS), servicing, monitoring and treasury tables.
-- Every statement is CREATE TABLE IF NOT EXISTS, so this file is safe to apply
-- on every boot. Columns added to tables that already existed live in
-- migrate.js (ensureLosColumns), because CREATE IF NOT EXISTS cannot add them.
-- ============================================================================

CREATE TABLE IF NOT EXISTS app_settings (
  skey        VARCHAR(64)  NOT NULL,
  svalue      JSON         NOT NULL,
  updated_by  VARCHAR(120) NOT NULL DEFAULT '',
  updated_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (skey)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS investors (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name       VARCHAR(190)    NOT NULL,
  tier       ENUM('1','2','neutral') NOT NULL DEFAULT 'neutral',
  created_at DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_investor_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS credit_applications (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  app_code         VARCHAR(24)     NOT NULL DEFAULT '',
  legal_name       VARCHAR(190)    NOT NULL,
  entity_type      VARCHAR(48)     NOT NULL DEFAULT '',
  sector           VARCHAR(120)    NOT NULL DEFAULT '',
  product          ENUM('quick_cash','rocket_fuel','bullet') NOT NULL,
  requested_amount DECIMAL(18,2)   NOT NULL DEFAULT 0,
  tenure_value     INT             NOT NULL DEFAULT 90,
  tenure_unit      ENUM('days','months') NOT NULL DEFAULT 'days',
  tenor_days       INT             NOT NULL DEFAULT 90,
  purpose          TEXT            NULL,
  repayment_source TEXT            NULL,
  promoter_name    VARCHAR(120)    NOT NULL DEFAULT '',
  promoter_mobile  VARCHAR(40)     NOT NULL DEFAULT '',
  company_pan      VARCHAR(20)     NOT NULL DEFAULT '',
  gstin            VARCHAR(24)     NOT NULL DEFAULT '',
  vcs              JSON            NULL,
  stage            VARCHAR(24)     NOT NULL DEFAULT 'Docs Pending',
  decline_reason   VARCHAR(500)    NOT NULL DEFAULT '',
  eligibility      JSON            NULL,
  rate_build       JSON            NULL,
  policy_check     JSON            NULL,
  cam              JSON            NULL,
  sanction         JSON            NULL,
  extra_rows       JSON            NULL,
  borrower_id      BIGINT UNSIGNED NULL,
  created_by_id    BIGINT UNSIGNED NULL,
  created_by       VARCHAR(120)    NOT NULL DEFAULT '',
  created_at       DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at       DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_app_stage (stage, updated_at),
  KEY ix_app_product (product),
  KEY ix_app_borrower (borrower_id),
  CONSTRAINT fk_app_borrower FOREIGN KEY (borrower_id) REFERENCES borrowers (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS application_receivables (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  application_id BIGINT UNSIGNED NOT NULL,
  kind           VARCHAR(16)     NOT NULL DEFAULT 'PO',
  number         VARCHAR(80)     NOT NULL,
  buyer          VARCHAR(190)    NOT NULL DEFAULT '',
  value          DECIMAL(18,2)   NOT NULL DEFAULT 0,
  doc_date       DATE            NULL,
  due_date       DATE            NULL,
  document_id    BIGINT UNSIGNED NULL,
  created_by     VARCHAR(120)    NOT NULL DEFAULT '',
  created_at     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_recv_number (application_id, number),
  CONSTRAINT fk_recv_app FOREIGN KEY (application_id) REFERENCES credit_applications (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS application_deviations (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  application_id  BIGINT UNSIGNED NOT NULL,
  n               INT             NOT NULL DEFAULT 1,
  status          ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  reason          TEXT            NULL,
  controls        JSON            NULL,
  note            TEXT            NULL,
  raised_by_id    BIGINT UNSIGNED NULL,
  raised_by       VARCHAR(120)    NOT NULL DEFAULT '',
  raised_at       DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  decided_by      VARCHAR(120)    NULL,
  decided_at      DATETIME(3)     NULL,
  checker_comment TEXT            NULL,
  pricing_bump    DECIMAL(4,1)    NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY ix_dev_app (application_id, n),
  KEY ix_dev_status (status),
  CONSTRAINT fk_dev_app FOREIGN KEY (application_id) REFERENCES credit_applications (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS disbursement_requests (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  borrower_id        BIGINT UNSIGNED NOT NULL,
  kind               ENUM('fresh','rotation') NOT NULL DEFAULT 'fresh',
  source_drawdown_id BIGINT UNSIGNED NULL,
  amount             DECIMAL(18,2)   NOT NULL DEFAULT 0,
  value_date         DATE            NOT NULL,
  mode               ENUM('none','30d','1m','2m','custom') NOT NULL DEFAULT 'none',
  cd                 INT             NULL,
  fee_pct            DECIMAL(8,4)    NULL,
  ref                VARCHAR(80)     NOT NULL DEFAULT '',
  remarks            VARCHAR(255)    NOT NULL DEFAULT '',
  status             ENUM('pending','approved','disbursed','rejected') NOT NULL DEFAULT 'pending',
  raised_by_id       BIGINT UNSIGNED NULL,
  raised_by          VARCHAR(120)    NOT NULL DEFAULT '',
  raised_at          DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  decided_by_id      BIGINT UNSIGNED NULL,
  decided_by         VARCHAR(120)    NULL,
  decided_at         DATETIME(3)     NULL,
  decision_note      VARCHAR(500)    NOT NULL DEFAULT '',
  paid_by            VARCHAR(120)    NULL,
  paid_at            DATETIME(3)     NULL,
  drawdown_id        BIGINT UNSIGNED NULL,
  PRIMARY KEY (id),
  KEY ix_disb_status (status, id),
  KEY ix_disb_borrower (borrower_id),
  CONSTRAINT fk_disb_borrower FOREIGN KEY (borrower_id) REFERENCES borrowers (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS limit_enhancements (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  borrower_id    BIGINT UNSIGNED NOT NULL,
  from_limit     DECIMAL(18,2)   NOT NULL DEFAULT 0,
  new_limit      DECIMAL(18,2)   NOT NULL DEFAULT 0,
  effective_date DATE            NOT NULL,
  sizing         JSON            NULL,
  board_flag     TINYINT(1)      NOT NULL DEFAULT 0,
  notes          TEXT            NULL,
  status         ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  raised_by_id   BIGINT UNSIGNED NULL,
  raised_by      VARCHAR(120)    NOT NULL DEFAULT '',
  raised_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  decided_by     VARCHAR(120)    NULL,
  decided_at     DATETIME(3)     NULL,
  decision_note  VARCHAR(500)    NOT NULL DEFAULT '',
  limit_event_id BIGINT UNSIGNED NULL,
  PRIMARY KEY (id),
  KEY ix_enh_status (status, id),
  KEY ix_enh_borrower (borrower_id),
  CONSTRAINT fk_enh_borrower FOREIGN KEY (borrower_id) REFERENCES borrowers (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS renewal_cases (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  borrower_id    BIGINT UNSIGNED NOT NULL,
  new_expiry     DATE            NOT NULL,
  current_rate   DECIMAL(8,4)    NOT NULL DEFAULT 0,
  new_rate       DECIMAL(8,4)    NOT NULL DEFAULT 0,
  cut_bps        INT             NOT NULL DEFAULT 0,
  gates          JSON            NULL,
  behaviour      TEXT            NULL,
  deviation_note TEXT            NULL,
  status         ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  raised_by_id   BIGINT UNSIGNED NULL,
  raised_by      VARCHAR(120)    NOT NULL DEFAULT '',
  raised_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  decided_by     VARCHAR(120)    NULL,
  decided_at     DATETIME(3)     NULL,
  decision_note  VARCHAR(500)    NOT NULL DEFAULT '',
  PRIMARY KEY (id),
  KEY ix_ren_status (status, id),
  KEY ix_ren_borrower (borrower_id),
  CONSTRAINT fk_ren_borrower FOREIGN KEY (borrower_id) REFERENCES borrowers (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ews_alerts (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  borrower_id     BIGINT UNSIGNED NOT NULL,
  rule_key        VARCHAR(40)     NULL,
  auto            TINYINT(1)      NOT NULL DEFAULT 0,
  severity        ENUM('low','medium','high') NOT NULL DEFAULT 'medium',
  message         VARCHAR(1000)   NOT NULL DEFAULT '',
  status          ENUM('open','acknowledged','resolved') NOT NULL DEFAULT 'open',
  raised_by       VARCHAR(120)    NOT NULL DEFAULT '',
  created_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  acknowledged_by VARCHAR(120)    NULL,
  acknowledged_at DATETIME(3)     NULL,
  resolved_by     VARCHAR(120)    NULL,
  resolved_at     DATETIME(3)     NULL,
  resolution      VARCHAR(1000)   NOT NULL DEFAULT '',
  requested_docs  JSON            NULL,
  PRIMARY KEY (id),
  KEY ix_ews_status (status, severity),
  KEY ix_ews_borrower (borrower_id, rule_key, status),
  CONSTRAINT fk_ews_borrower FOREIGN KEY (borrower_id) REFERENCES borrowers (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS site_visits (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  borrower_id BIGINT UNSIGNED NOT NULL,
  visit_date  DATE            NOT NULL,
  visited_by  VARCHAR(120)    NOT NULL DEFAULT '',
  notes       TEXT            NULL,
  created_by  VARCHAR(120)    NOT NULL DEFAULT '',
  created_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_visit_borrower (borrower_id, visit_date),
  CONSTRAINT fk_visit_borrower FOREIGN KEY (borrower_id) REFERENCES borrowers (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS borrower_mis (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  borrower_id  BIGINT UNSIGNED NOT NULL,
  month        CHAR(7)         NOT NULL,
  revenue      DECIMAL(18,2)   NOT NULL DEFAULT 0,
  burn         DECIMAL(18,2)   NOT NULL DEFAULT 0,
  closing_cash DECIMAL(18,2)   NOT NULL DEFAULT 0,
  note         VARCHAR(255)    NOT NULL DEFAULT '',
  created_by   VARCHAR(120)    NOT NULL DEFAULT '',
  created_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_mis_month (borrower_id, month),
  CONSTRAINT fk_mis_borrower FOREIGN KEY (borrower_id) REFERENCES borrowers (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS capital_funding (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  entry_date   DATE            NOT NULL,
  source       VARCHAR(60)     NOT NULL,
  counterparty VARCHAR(190)    NOT NULL DEFAULT '',
  direction    ENUM('in','out') NOT NULL DEFAULT 'in',
  amount       DECIMAL(18,2)   NOT NULL DEFAULT 0,
  rate         DECIMAL(8,4)    NOT NULL DEFAULT 0,
  maturity     DATE            NULL,
  remarks      VARCHAR(255)    NOT NULL DEFAULT '',
  created_by   VARCHAR(120)    NOT NULL DEFAULT '',
  created_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_fund_date (entry_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS capital_parked (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  as_of      DATE            NOT NULL,
  bucket     VARCHAR(60)     NOT NULL,
  label      VARCHAR(190)    NOT NULL DEFAULT '',
  balance    DECIMAL(18,2)   NOT NULL DEFAULT 0,
  note       VARCHAR(255)    NOT NULL DEFAULT '',
  created_by VARCHAR(120)    NOT NULL DEFAULT '',
  created_at DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_parked_asof (as_of, bucket)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
