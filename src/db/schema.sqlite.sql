-- SQLite-compatible schema for local/dev runs.
-- The canonical Postgres schema lives in migrations/001_init.sql.
-- Money is stored as INTEGER pesewas (1 GHS = 100). Never floats.

CREATE TABLE IF NOT EXISTS merchants (
  id            TEXT PRIMARY KEY,
  business_name TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  country       TEXT NOT NULL DEFAULT 'GH',
  currency      TEXT NOT NULL DEFAULT 'GHS',
  status        TEXT NOT NULL DEFAULT 'active',
  fee_bps       INTEGER NOT NULL DEFAULT 195,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  merchant_id   TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'owner',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS api_keys (
  id             TEXT PRIMARY KEY,
  merchant_id    TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  public_key     TEXT NOT NULL UNIQUE,
  secret_hash    TEXT NOT NULL,
  secret_last4   TEXT NOT NULL,
  webhook_url    TEXT,
  webhook_secret TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active',
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_api_keys_public ON api_keys(public_key);

CREATE TABLE IF NOT EXISTS payments (
  id                 TEXT PRIMARY KEY,
  merchant_id        TEXT NOT NULL REFERENCES merchants(id),
  amount             INTEGER NOT NULL CHECK (amount > 0),
  fee                INTEGER NOT NULL DEFAULT 0,
  net                INTEGER NOT NULL DEFAULT 0,
  currency           TEXT NOT NULL DEFAULT 'GHS',
  channel            TEXT NOT NULL CHECK (channel IN ('momo','card')),
  provider           TEXT,
  customer_msisdn    TEXT,
  customer_email     TEXT,
  reference          TEXT NOT NULL,
  description        TEXT,
  status             TEXT NOT NULL DEFAULT 'created',
  provider_reference TEXT UNIQUE,
  failure_reason     TEXT,
  refunded_amount    INTEGER NOT NULL DEFAULT 0,
  metadata           TEXT NOT NULL DEFAULT '{}',
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payments_merchant ON payments(merchant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_payments_status   ON payments(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_merchant_reference
  ON payments(merchant_id, reference);

CREATE TABLE IF NOT EXISTS ledger_accounts (
  id          TEXT PRIMARY KEY,
  merchant_id TEXT REFERENCES merchants(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  currency    TEXT NOT NULL DEFAULT 'GHS',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (merchant_id, type, currency)
);

CREATE TABLE IF NOT EXISTS journal_entries (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  payment_id  TEXT REFERENCES payments(id),
  description TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS postings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id   TEXT NOT NULL REFERENCES journal_entries(id),
  account_id TEXT NOT NULL REFERENCES ledger_accounts(id),
  amount     INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_postings_account ON postings(account_id);

CREATE TABLE IF NOT EXISTS account_balances (
  account_id TEXT PRIMARY KEY REFERENCES ledger_accounts(id),
  balance    INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key           TEXT PRIMARY KEY,
  merchant_id   TEXT NOT NULL,
  request_hash  TEXT NOT NULL,
  response_code INTEGER,
  response_body TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id            TEXT PRIMARY KEY,
  merchant_id   TEXT NOT NULL REFERENCES merchants(id),
  type          TEXT NOT NULL,
  payload       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  attempts      INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_webhook_events_status ON webhook_events(status);

CREATE TABLE IF NOT EXISTS settlements (
  id           TEXT PRIMARY KEY,
  merchant_id  TEXT NOT NULL REFERENCES merchants(id),
  amount       INTEGER NOT NULL,
  currency     TEXT NOT NULL DEFAULT 'GHS',
  status       TEXT NOT NULL DEFAULT 'pending',
  period_start TEXT NOT NULL,
  period_end   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_settlements_merchant ON settlements(merchant_id);
