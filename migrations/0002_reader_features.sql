-- What readers send: comments and the reports on them, reactions,
-- correction reports and contact messages.

-- status: pending (awaiting a moderator), approved (public), spam, hidden, deleted.
-- The author's email is kept only as a keyed hash; nothing but the name and
-- website is ever served.
CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  parent_id TEXT,
  author_name TEXT NOT NULL,
  author_url TEXT,
  author_email_hash TEXT,
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'spam', 'hidden', 'deleted')),
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE INDEX comments_by_page ON comments (path, status, created_at);

-- A reader's report on a published comment. status: open, dismissed, hidden, deleted.
CREATE TABLE abuse_reports (
  id TEXT PRIMARY KEY,
  comment_id TEXT NOT NULL REFERENCES comments (id),
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'dismissed', 'hidden', 'deleted')),
  created_at TEXT NOT NULL
);

CREATE INDEX abuse_reports_by_status ON abuse_reports (status, created_at);

-- One reaction per reader per page per day; reader_hash is a keyed hash of
-- the address, the page and the day.
CREATE TABLE reactions (
  path TEXT NOT NULL,
  reader_hash TEXT NOT NULL,
  reaction TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (path, reader_hash)
);

-- status: new, reviewed, accepted, resolved, rejected. contact_email is the
-- reporter's, for an answer, and reaches moderators only.
CREATE TABLE corrections (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  article_url TEXT NOT NULL,
  article_title TEXT,
  category TEXT NOT NULL,
  section TEXT,
  message TEXT NOT NULL,
  quote TEXT,
  contact_email TEXT,
  status TEXT NOT NULL CHECK (status IN ('new', 'reviewed', 'accepted', 'resolved', 'rejected')),
  resolution_url TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX corrections_by_status ON corrections (status, created_at);

-- Private messages to the author; never published.
CREATE TABLE contact_messages (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  affiliation TEXT,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  source_url TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX contact_messages_by_age ON contact_messages (created_at);
