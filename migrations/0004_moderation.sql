-- The audit trail of the moderation inbox: every action, when, by which
-- moderator (the login the session names, never one the browser sends), with
-- the note and, for a resolved correction, the address that settled it.
CREATE TABLE moderation_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  action TEXT NOT NULL,
  at TEXT NOT NULL,
  moderator TEXT NOT NULL,
  note TEXT,
  link TEXT
);

CREATE INDEX moderation_history_by_item ON moderation_history (item_id, at);

-- The queue is read by status and age from each table.
CREATE INDEX comments_by_status ON comments (status, created_at);
