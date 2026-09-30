-- Newsletter subscribers, the mail outbox and Webmentions.

-- status: pending (awaiting confirmation), confirmed, unsubscribed.
-- token_version rises on unsubscribing, which invalidates every earlier link;
-- the tokens themselves are signed, never stored.
CREATE TABLE subscribers (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'unsubscribed')),
  topics TEXT NOT NULL DEFAULT '[]',
  locale TEXT,
  source_url TEXT,
  token_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  unsubscribed_at TEXT,
  last_mailed_at TEXT
);

-- Mail that MAIL_PROVIDER=outbox keeps instead of sending, for development
-- and the conformance suite.
CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  to_address TEXT NOT NULL,
  reply_to TEXT,
  subject TEXT NOT NULL,
  text TEXT NOT NULL,
  headers TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX outbox_by_recipient ON outbox (to_address, created_at);

-- status: pending (received, not yet checked), verified (shown), rejected
-- (the source does not link), deleted (the source is gone).
CREATE TABLE webmentions (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('mention', 'reply', 'repost', 'like')),
  author_name TEXT,
  author_url TEXT,
  title TEXT,
  excerpt TEXT,
  published_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'verified', 'rejected', 'deleted')),
  received_at TEXT NOT NULL,
  verified_at TEXT,
  UNIQUE (source, target)
);

CREATE INDEX webmentions_by_target ON webmentions (target, status, published_at);
