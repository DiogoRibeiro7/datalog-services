-- What every route shares: rate-limit windows and idempotency keys.

-- One row per rule and client key; count is the requests in window_start's window.
CREATE TABLE rate_limits (
  bucket TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);

-- A write's Idempotency-Key, per method and path, with the answer it got.
-- state is 'running' until the answer is stored, then 'done'.
CREATE TABLE idempotency_keys (
  key TEXT NOT NULL,
  scope TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'done')),
  status INTEGER,
  body TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (key, scope)
);

CREATE INDEX idempotency_keys_by_age ON idempotency_keys (created_at);
