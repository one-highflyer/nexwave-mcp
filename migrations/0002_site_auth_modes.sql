CREATE TABLE sites_v2 (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  auth_type TEXT NOT NULL CHECK (auth_type IN ('oauth', 'api_token')),
  client_id TEXT,
  encrypted_client_secret TEXT,
  encrypted_api_key TEXT,
  encrypted_api_secret TEXT,
  api_user TEXT,
  service_token_hash TEXT UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (base_url, auth_type),
  CHECK (
    (
      auth_type = 'oauth'
      AND client_id IS NOT NULL
      AND encrypted_client_secret IS NOT NULL
      AND encrypted_api_key IS NULL
      AND encrypted_api_secret IS NULL
      AND api_user IS NULL
      AND service_token_hash IS NULL
    )
    OR
    (
      auth_type = 'api_token'
      AND client_id IS NULL
      AND encrypted_client_secret IS NULL
      AND encrypted_api_key IS NOT NULL
      AND encrypted_api_secret IS NOT NULL
      AND api_user IS NOT NULL
      AND service_token_hash IS NOT NULL
    )
  )
);

INSERT INTO sites_v2 (
  id, display_name, base_url, auth_type, client_id, encrypted_client_secret,
  encrypted_api_key, encrypted_api_secret, api_user, service_token_hash,
  enabled, created_at, updated_at
)
SELECT
  id, display_name, base_url, 'oauth', client_id, encrypted_client_secret,
  NULL, NULL, NULL, NULL, enabled, created_at, updated_at
FROM sites;

DROP TABLE sites;
ALTER TABLE sites_v2 RENAME TO sites;

CREATE INDEX sites_enabled_name_idx
  ON sites (enabled, display_name);
