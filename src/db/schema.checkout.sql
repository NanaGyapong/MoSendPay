-- Checkout sessions: a public, short-lived intent the customer completes on the
-- hosted page. The merchant creates it with their secret key; the customer only
-- ever sees the public session id, never the API key.

CREATE TABLE IF NOT EXISTS checkout_sessions (
  id            TEXT PRIMARY KEY,            -- cs_xxx (public, used in the URL)
  merchant_id   TEXT NOT NULL REFERENCES merchants(id),
  amount        INTEGER NOT NULL CHECK (amount > 0),
  currency      TEXT NOT NULL DEFAULT 'GHS',
  reference     TEXT NOT NULL,
  description   TEXT,
  status        TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','completed','expired')),
  payment_id    TEXT REFERENCES payments(id),
  success_url   TEXT,
  expires_at    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_checkout_merchant ON checkout_sessions(merchant_id);
