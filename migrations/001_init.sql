-- MosendPay schema — PostgreSQL
-- All money is stored as BIGINT in pesewas (1 GHS = 100 pesewas). Never floats.

-- ─────────────────────────────────────────────────────────────────────────────
-- Merchants & users
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS merchants (
  id              TEXT PRIMARY KEY,            -- mrch_xxx
  business_name   TEXT NOT NULL,
  email           TEXT NOT NULL UNIQUE,
  country         TEXT NOT NULL DEFAULT 'GH',
  currency        TEXT NOT NULL DEFAULT 'GHS',
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','suspended','pending')),
  fee_bps         INTEGER NOT NULL DEFAULT 195, -- 1.95% in basis points
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,            -- usr_xxx
  merchant_id     TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  email           TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'owner'
                    CHECK (role IN ('owner','admin','viewer')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- API keys. We store only a hash of the secret key.
CREATE TABLE IF NOT EXISTS api_keys (
  id              TEXT PRIMARY KEY,            -- key_xxx
  merchant_id     TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  public_key      TEXT NOT NULL UNIQUE,        -- pk_live_xxx (not secret)
  secret_hash     TEXT NOT NULL,               -- bcrypt(sk_live_xxx)
  secret_last4    TEXT NOT NULL,               -- for display
  webhook_url     TEXT,
  webhook_secret  TEXT NOT NULL,               -- used to sign webhooks (whsec_xxx)
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','revoked')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_api_keys_public ON api_keys(public_key);

-- ─────────────────────────────────────────────────────────────────────────────
-- Payments
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS payments (
  id                 TEXT PRIMARY KEY,         -- pay_xxx
  merchant_id        TEXT NOT NULL REFERENCES merchants(id),
  amount             BIGINT NOT NULL CHECK (amount > 0),   -- pesewas
  fee                BIGINT NOT NULL DEFAULT 0,
  net                BIGINT NOT NULL DEFAULT 0,
  currency           TEXT NOT NULL DEFAULT 'GHS',
  channel            TEXT NOT NULL CHECK (channel IN ('momo','card')),
  provider           TEXT,                     -- 'mtn','telecel','airteltigo','card'
  customer_msisdn    TEXT,                     -- payer phone (momo)
  customer_email     TEXT,
  reference          TEXT NOT NULL,            -- merchant's own reference
  description        TEXT,
  status             TEXT NOT NULL DEFAULT 'created'
                       CHECK (status IN ('created','pending','processing',
                                         'succeeded','failed','cancelled',
                                         'refunded','partially_refunded')),
  provider_reference TEXT UNIQUE,              -- idempotency anchor for callbacks
  failure_reason     TEXT,
  refunded_amount    BIGINT NOT NULL DEFAULT 0,
  metadata           JSONB NOT NULL DEFAULT '{}',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payments_merchant ON payments(merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_status   ON payments(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_merchant_reference
  ON payments(merchant_id, reference);

-- ─────────────────────────────────────────────────────────────────────────────
-- Double-entry ledger
-- ─────────────────────────────────────────────────────────────────────────────

-- Accounts: one per merchant + system accounts.
CREATE TABLE IF NOT EXISTS ledger_accounts (
  id           TEXT PRIMARY KEY,              -- acct_xxx
  merchant_id  TEXT REFERENCES merchants(id) ON DELETE CASCADE, -- null for system
  type         TEXT NOT NULL,                 -- 'merchant_available','psp_clearing',
                                              -- 'fees_income','settlement_payable'
  currency     TEXT NOT NULL DEFAULT 'GHS',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, type, currency)
);

-- Journal entries group balanced postings.
CREATE TABLE IF NOT EXISTS journal_entries (
  id           TEXT PRIMARY KEY,              -- jrn_xxx
  kind         TEXT NOT NULL,                 -- 'payment','refund','settlement'
  payment_id   TEXT REFERENCES payments(id),
  description  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Postings: append-only. Sum of amount per entry must be zero (DR negative, CR positive).
CREATE TABLE IF NOT EXISTS postings (
  id           BIGSERIAL PRIMARY KEY,
  entry_id     TEXT NOT NULL REFERENCES journal_entries(id),
  account_id   TEXT NOT NULL REFERENCES ledger_accounts(id),
  amount       BIGINT NOT NULL,               -- signed: +credit, -debit (pesewas)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_postings_account ON postings(account_id);

-- Cached balance per account (updated in the same txn as postings for fast reads).
CREATE TABLE IF NOT EXISTS account_balances (
  account_id   TEXT PRIMARY KEY REFERENCES ledger_accounts(id),
  balance      BIGINT NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Idempotency & webhook delivery
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key           TEXT PRIMARY KEY,
  merchant_id   TEXT NOT NULL,
  request_hash  TEXT NOT NULL,
  response_code INTEGER,
  response_body JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id            TEXT PRIMARY KEY,             -- evt_xxx
  merchant_id   TEXT NOT NULL REFERENCES merchants(id),
  type          TEXT NOT NULL,               -- 'payment.succeeded' etc.
  payload       JSONB NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','delivered','failed')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_webhook_events_status ON webhook_events(status);

-- ─────────────────────────────────────────────────────────────────────────────
-- Settlements (batched payout records to merchants)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS settlements (
  id            TEXT PRIMARY KEY,            -- stl_xxx
  merchant_id   TEXT NOT NULL REFERENCES merchants(id),
  amount        BIGINT NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'GHS',
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','paid','failed')),
  period_start  TIMESTAMPTZ NOT NULL,
  period_end    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_settlements_merchant ON settlements(merchant_id);
