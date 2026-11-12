ALTER TABLE sites ADD COLUMN write_capabilities TEXT NOT NULL DEFAULT '[]';

-- Reserve before contacting Frappe. An uncertain outcome must never be replayed as a new write.
CREATE TABLE write_requests (
  site_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  request_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  document_name TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'complete', 'unknown')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (site_id, user_id, operation, request_key)
);
