-- ============================================================================
-- Valuefin Desk — MySQL schema
-- Engine: InnoDB · Charset: utf8mb4 · All money DECIMAL(18,2), rates DECIMAL(8,4)
-- Business dates are DATE (no timezone drift); audit timestamps are DATETIME(3).
-- ============================================================================

CREATE TABLE IF NOT EXISTS users (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name          VARCHAR(120)    NOT NULL,
  email         VARCHAR(190)    NOT NULL,
  role          ENUM('director','manager','analyst') NOT NULL DEFAULT 'analyst',
  password_hash VARCHAR(255)    NOT NULL,
  active        TINYINT(1)      NOT NULL DEFAULT 1,
  must_reset    TINYINT(1)      NOT NULL DEFAULT 0,
  last_login_at DATETIME(3)     NULL,
  created_at    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email),
  KEY ix_users_role (role, active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sessions (
  id          CHAR(36)        NOT NULL,
  user_id     BIGINT UNSIGNED NOT NULL,
  ip          VARCHAR(64)     NULL,
  user_agent  VARCHAR(255)    NULL,
  created_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at  DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  KEY ix_sessions_user (user_id),
  KEY ix_sessions_exp (expires_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS borrowers (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  slug          VARCHAR(80)     NOT NULL,
  name          VARCHAR(190)    NOT NULL,
  biz           VARCHAR(190)    NOT NULL DEFAULT '',
  loan_type     ENUM('po','io') NOT NULL DEFAULT 'po',
  base_limit    DECIMAL(18,2)   NOT NULL DEFAULT 0,
  rate          DECIMAL(8,4)    NOT NULL DEFAULT 18,
  pen_rate      DECIMAL(8,4)    NOT NULL DEFAULT 6,
  proc_fee_pct  DECIMAL(8,4)    NOT NULL DEFAULT 1.5,
  gst_pct       DECIMAL(8,4)    NOT NULL DEFAULT 18,
  tenure        INT             NOT NULL DEFAULT 90,
  tenure_unit   ENUM('days','months') NOT NULL DEFAULT 'days',
  sanction_date DATE            NOT NULL,
  status        ENUM('active','closed') NOT NULL DEFAULT 'active',
  contact_name  VARCHAR(120)    NOT NULL DEFAULT '',
  contact_email VARCHAR(190)    NOT NULL DEFAULT '',
  contact_phone VARCHAR(40)     NOT NULL DEFAULT '',
  pan           VARCHAR(20)     NOT NULL DEFAULT '',
  gstin         VARCHAR(24)     NOT NULL DEFAULT '',
  is_sample     TINYINT(1)      NOT NULL DEFAULT 0,
  created_by    VARCHAR(120)    NOT NULL DEFAULT '',
  created_at    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_borrowers_slug (slug),
  UNIQUE KEY uq_borrowers_name (name),
  KEY ix_borrowers_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Sanctioned-limit enhancements. Current limit = borrowers.base_limit + SUM(incr_amt).
CREATE TABLE IF NOT EXISTS limit_history (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  borrower_id BIGINT UNSIGNED NOT NULL,
  event_date  DATE            NOT NULL,
  incr_amt    DECIMAL(18,2)   NOT NULL DEFAULT 0,
  note        VARCHAR(255)    NOT NULL DEFAULT '',
  created_by  VARCHAR(120)    NOT NULL DEFAULT '',
  created_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_limit_borrower (borrower_id, event_date),
  CONSTRAINT fk_limit_borrower FOREIGN KEY (borrower_id) REFERENCES borrowers (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS drawdowns (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  borrower_id   BIGINT UNSIGNED NOT NULL,
  ref           VARCHAR(80)     NOT NULL DEFAULT '',
  po_amt        DECIMAL(18,2)   NOT NULL DEFAULT 0,
  bank_debit    DATE            NOT NULL,
  mode          ENUM('none','30d','1m','2m','custom') NOT NULL DEFAULT 'none',
  cd            INT             NULL,
  ad            INT             NOT NULL DEFAULT 0,
  adv           DECIMAL(18,2)   NOT NULL DEFAULT 0,
  fee_pct       DECIMAL(8,4)    NOT NULL DEFAULT 0,
  fee           DECIMAL(18,2)   NOT NULL DEFAULT 0,
  gst_amt       DECIMAL(18,2)   NOT NULL DEFAULT 0,
  disbursed     DECIMAL(18,2)   NOT NULL DEFAULT 0,
  out_prin      DECIMAL(18,2)   NOT NULL DEFAULT 0,
  int_overhang  DECIMAL(18,2)   NOT NULL DEFAULT 0,
  int_collected DECIMAL(18,2)   NOT NULL DEFAULT 0,
  loan_type     ENUM('po','io') NOT NULL DEFAULT 'po',
  status        ENUM('Open','Repaid') NOT NULL DEFAULT 'Open',
  rem           VARCHAR(255)    NOT NULL DEFAULT '',
  rotated_from  BIGINT UNSIGNED NULL,
  created_by    VARCHAR(120)    NOT NULL DEFAULT '',
  created_at    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_dd_borrower (borrower_id, bank_debit),
  KEY ix_dd_status (status),
  CONSTRAINT fk_dd_borrower FOREIGN KEY (borrower_id) REFERENCES borrowers (id) ON DELETE CASCADE,
  CONSTRAINT fk_dd_rotated FOREIGN KEY (rotated_from) REFERENCES drawdowns (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payments (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  borrower_id  BIGINT UNSIGNED NOT NULL,
  drawdown_id  BIGINT UNSIGNED NOT NULL,
  ref          VARCHAR(80)     NOT NULL DEFAULT '',
  pay_date     DATE            NOT NULL,
  amount       DECIMAL(18,2)   NOT NULL DEFAULT 0,
  int_adj      DECIMAL(18,2)   NOT NULL DEFAULT 0,
  prin_adj     DECIMAL(18,2)   NOT NULL DEFAULT 0,
  out_after    DECIMAL(18,2)   NOT NULL DEFAULT 0,
  closed       TINYINT(1)      NOT NULL DEFAULT 0,
  kind         VARCHAR(24)     NOT NULL DEFAULT 'po',
  rem          VARCHAR(255)    NOT NULL DEFAULT '',
  created_by   VARCHAR(120)    NOT NULL DEFAULT '',
  created_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_pay_borrower (borrower_id, pay_date),
  KEY ix_pay_drawdown (drawdown_id, pay_date, id),
  CONSTRAINT fk_pay_borrower FOREIGN KEY (borrower_id) REFERENCES borrowers (id) ON DELETE CASCADE,
  CONSTRAINT fk_pay_drawdown FOREIGN KEY (drawdown_id) REFERENCES drawdowns (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS documents (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  borrower_id    BIGINT UNSIGNED NOT NULL,
  title          VARCHAR(190)    NOT NULL,
  filename       VARCHAR(255)    NOT NULL,
  stored_name    VARCHAR(255)    NOT NULL,
  rel_path       VARCHAR(512)    NOT NULL,
  size_bytes     BIGINT UNSIGNED NOT NULL DEFAULT 0,
  category       VARCHAR(48)     NOT NULL DEFAULT 'Other',
  checklist_key  VARCHAR(40)     NULL,
  uploaded_by_id BIGINT UNSIGNED NULL,
  uploaded_by    VARCHAR(120)    NOT NULL DEFAULT '',
  uploaded_at    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  status         ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  decided_by     VARCHAR(120)    NULL,
  decided_at     DATETIME(3)     NULL,
  reason         VARCHAR(500)    NOT NULL DEFAULT '',
  PRIMARY KEY (id),
  KEY ix_doc_borrower (borrower_id, id),
  KEY ix_doc_status (status, id),
  KEY ix_doc_checklist (borrower_id, checklist_key),
  CONSTRAINT fk_doc_borrower FOREIGN KEY (borrower_id) REFERENCES borrowers (id) ON DELETE CASCADE,
  CONSTRAINT fk_doc_user FOREIGN KEY (uploaded_by_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS notifications (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  to_user_id    BIGINT UNSIGNED NULL,
  to_role       ENUM('director','manager','analyst') NULL,
  type          VARCHAR(32)     NOT NULL DEFAULT '',
  message       VARCHAR(500)    NOT NULL DEFAULT '',
  doc_id        BIGINT UNSIGNED NULL,
  borrower_id   BIGINT UNSIGNED NULL,
  customer_name VARCHAR(190)    NULL,
  is_read       TINYINT(1)      NOT NULL DEFAULT 0,
  created_at    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_notif_user (to_user_id, is_read, id),
  KEY ix_notif_role (to_role, is_read, id),
  CONSTRAINT fk_notif_user FOREIGN KEY (to_user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    BIGINT UNSIGNED NULL,
  user_name  VARCHAR(120)    NOT NULL DEFAULT 'system',
  role       VARCHAR(24)     NOT NULL DEFAULT '',
  action     VARCHAR(48)     NOT NULL,
  entity     VARCHAR(32)     NOT NULL DEFAULT '',
  entity_id  VARCHAR(64)     NULL,
  summary    VARCHAR(500)    NOT NULL DEFAULT '',
  detail     JSON            NULL,
  ip         VARCHAR(64)     NULL,
  created_at DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_audit_created (created_at),
  KEY ix_audit_entity (entity, entity_id),
  KEY ix_audit_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
