-- Primary D1 owns policy and accounting. Back up policies separately from cache data.
CREATE TABLE deployment (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  writes_enabled INTEGER NOT NULL DEFAULT 1 CHECK (writes_enabled IN (0, 1)),
  byte_limit INTEGER NOT NULL DEFAULT 8000000000 CHECK (byte_limit > 0),
  entry_limit INTEGER NOT NULL DEFAULT 20000 CHECK (entry_limit > 0),
  association_limit INTEGER NOT NULL DEFAULT 20000 CHECK (association_limit > 0),
  retention_high_water_seconds INTEGER NOT NULL DEFAULT 604800,
  charged_bytes INTEGER NOT NULL DEFAULT 0 CHECK (charged_bytes >= 0),
  entry_count INTEGER NOT NULL DEFAULT 0 CHECK (entry_count >= 0),
  association_count INTEGER NOT NULL DEFAULT 0 CHECK (association_count >= 0)
);
INSERT INTO deployment (id) VALUES (1);
CREATE TABLE scopes (
  scope_id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  repository TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  repository_owner_id TEXT NOT NULL,
  branch TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  writes_enabled INTEGER NOT NULL DEFAULT 1 CHECK (writes_enabled IN (0, 1)),
  policy_version INTEGER NOT NULL DEFAULT 1,
  retention_seconds INTEGER NOT NULL DEFAULT 604800 CHECK (retention_seconds > 0),
  byte_limit INTEGER NOT NULL DEFAULT 8000000000 CHECK (byte_limit > 0),
  entry_limit INTEGER NOT NULL DEFAULT 20000 CHECK (entry_limit > 0),
  association_limit INTEGER NOT NULL DEFAULT 20000 CHECK (association_limit > 0),
  charged_bytes INTEGER NOT NULL DEFAULT 0 CHECK (charged_bytes >= 0),
  entry_count INTEGER NOT NULL DEFAULT 0 CHECK (entry_count >= 0),
  association_count INTEGER NOT NULL DEFAULT 0 CHECK (association_count >= 0)
);
CREATE TABLE generations (
  generation_id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL REFERENCES scopes(scope_id),
  state TEXT NOT NULL CHECK (state IN ('uploading', 'ready', 'retired', 'deleting')),
  policy_version INTEGER NOT NULL,
  token_exp INTEGER NOT NULL,
  lease_until INTEGER NOT NULL,
  gc_after INTEGER NOT NULL,
  gc_claim TEXT,
  key BLOB,
  secondary_key BLOB,
  value_object TEXT NOT NULL UNIQUE,
  blob_object TEXT NOT NULL UNIQUE,
  blob_id TEXT,
  upload_id TEXT,
  value_size INTEGER NOT NULL DEFAULT 0 CHECK (value_size >= 0),
  blob_size INTEGER NOT NULL DEFAULT 0 CHECK (blob_size >= 0),
  charged_bytes INTEGER NOT NULL CHECK (charged_bytes >= 0),
  expires_at INTEGER,
  retired_at INTEGER,
  UNIQUE (scope_id, generation_id)
);
CREATE UNIQUE INDEX generations_blob ON generations(scope_id, blob_id) WHERE blob_id IS NOT NULL;
CREATE INDEX generations_gc ON generations(gc_after);
CREATE TABLE entries (
  scope_id TEXT NOT NULL REFERENCES scopes(scope_id),
  key BLOB NOT NULL CHECK (typeof(key) = 'blob'),
  generation_id TEXT NOT NULL,
  PRIMARY KEY (scope_id, key),
  FOREIGN KEY (scope_id, generation_id) REFERENCES generations(scope_id, generation_id) ON DELETE CASCADE
) WITHOUT ROWID;
CREATE INDEX entries_generation ON entries(generation_id);
CREATE TABLE associations (
  scope_id TEXT NOT NULL REFERENCES scopes(scope_id),
  secondary_key BLOB NOT NULL CHECK (typeof(secondary_key) = 'blob'),
  target_key BLOB NOT NULL CHECK (typeof(target_key) = 'blob'),
  PRIMARY KEY (scope_id, secondary_key)
) WITHOUT ROWID;
CREATE INDEX associations_target ON associations(scope_id, target_key);
CREATE TABLE maintenance (id INTEGER PRIMARY KEY CHECK (id = 1), scope_id TEXT NOT NULL, secondary_key BLOB NOT NULL);
INSERT INTO maintenance VALUES (1, '', X'');

-- Parenthesize CASE expressions so the D1 REST parser preserves each trigger body.
-- Lifecycle rules must never shorten the life of an already published generation.
CREATE TRIGGER initial_retention AFTER INSERT ON scopes BEGIN
  UPDATE deployment SET retention_high_water_seconds = max(retention_high_water_seconds, NEW.retention_seconds);
END;
CREATE TRIGGER increased_retention AFTER UPDATE OF retention_seconds ON scopes BEGIN
  UPDATE deployment SET retention_high_water_seconds = max(retention_high_water_seconds, NEW.retention_seconds);
END;
CREATE TRIGGER scope_limit BEFORE INSERT ON scopes
WHEN NOT EXISTS (SELECT 1 FROM scopes WHERE scope_id = NEW.scope_id)
BEGIN
  SELECT (CASE WHEN (SELECT count(*) FROM scopes) >= 100 THEN RAISE(ABORT, 'cache_scope_limit') END);
END;

-- Direct policy edits must invalidate uploads that captured the previous policy.
CREATE TRIGGER changed_policy AFTER UPDATE OF endpoint, repository_id, repository_owner_id, branch,
  enabled, writes_enabled, retention_seconds, byte_limit, entry_limit, association_limit ON scopes
WHEN NEW.policy_version = OLD.policy_version
BEGIN
  UPDATE scopes SET policy_version = OLD.policy_version + 1 WHERE scope_id = NEW.scope_id;
END;

CREATE TRIGGER reserve_capacity BEFORE INSERT ON generations BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM scopes s, deployment d WHERE s.scope_id = NEW.scope_id
      AND s.enabled = 1 AND s.writes_enabled = 1 AND d.enabled = 1 AND d.writes_enabled = 1
      AND s.policy_version = NEW.policy_version AND NEW.token_exp > unixepoch()
      AND s.charged_bytes + NEW.charged_bytes <= s.byte_limit
      AND d.charged_bytes + NEW.charged_bytes <= d.byte_limit
  ) THEN RAISE(ABORT, 'cache_admission_denied') END);
END;
CREATE TRIGGER charge_generation AFTER INSERT ON generations BEGIN
  UPDATE scopes SET charged_bytes = charged_bytes + NEW.charged_bytes WHERE scope_id = NEW.scope_id;
  UPDATE deployment SET charged_bytes = charged_bytes + NEW.charged_bytes;
END;
CREATE TRIGGER adjust_generation AFTER UPDATE OF charged_bytes ON generations BEGIN
  UPDATE scopes SET charged_bytes = charged_bytes + NEW.charged_bytes - OLD.charged_bytes WHERE scope_id = NEW.scope_id;
  UPDATE deployment SET charged_bytes = charged_bytes + NEW.charged_bytes - OLD.charged_bytes;
END;
CREATE TRIGGER release_generation AFTER DELETE ON generations BEGIN
  UPDATE scopes SET charged_bytes = charged_bytes - OLD.charged_bytes WHERE scope_id = OLD.scope_id;
  UPDATE deployment SET charged_bytes = charged_bytes - OLD.charged_bytes;
END;

CREATE TRIGGER count_entry BEFORE INSERT ON entries
WHEN NOT EXISTS (SELECT 1 FROM entries WHERE scope_id = NEW.scope_id AND key = NEW.key)
BEGIN
  SELECT (CASE WHEN EXISTS (
    SELECT 1 FROM scopes s, deployment d WHERE s.scope_id = NEW.scope_id
      AND (s.entry_count >= s.entry_limit OR d.entry_count >= d.entry_limit)
  ) THEN RAISE(ABORT, 'cache_entry_limit') END);
  UPDATE scopes SET entry_count = entry_count + 1 WHERE scope_id = NEW.scope_id;
  UPDATE deployment SET entry_count = entry_count + 1;
END;
CREATE TRIGGER uncount_entry AFTER DELETE ON entries BEGIN
  UPDATE scopes SET entry_count = entry_count - 1 WHERE scope_id = OLD.scope_id;
  UPDATE deployment SET entry_count = entry_count - 1;
END;
CREATE TRIGGER count_association BEFORE INSERT ON associations
WHEN NOT EXISTS (SELECT 1 FROM associations WHERE scope_id = NEW.scope_id AND secondary_key = NEW.secondary_key)
BEGIN
  SELECT (CASE WHEN EXISTS (
    SELECT 1 FROM scopes s, deployment d WHERE s.scope_id = NEW.scope_id
      AND (s.association_count >= s.association_limit OR d.association_count >= d.association_limit)
  ) THEN RAISE(ABORT, 'cache_association_limit') END);
  UPDATE scopes SET association_count = association_count + 1 WHERE scope_id = NEW.scope_id;
  UPDATE deployment SET association_count = association_count + 1;
END;
CREATE TRIGGER uncount_association AFTER DELETE ON associations BEGIN
  UPDATE scopes SET association_count = association_count - 1 WHERE scope_id = OLD.scope_id;
  UPDATE deployment SET association_count = association_count - 1;
END;

-- All publication mutations inherit the guarded state change's transaction.
-- A zero-row guard fires no trigger. A quota failure rolls every mutation back.
CREATE TRIGGER publish_generation AFTER UPDATE OF state ON generations
WHEN OLD.state = 'uploading' AND NEW.state = 'ready'
BEGIN
  UPDATE generations SET state = 'retired', retired_at = unixepoch(),
    gc_after = (CASE WHEN expires_at > unixepoch() THEN unixepoch() + 600 ELSE unixepoch() END)
    WHERE generation_id = (SELECT generation_id FROM entries WHERE scope_id = NEW.scope_id AND key = NEW.key) AND state = 'ready';
  INSERT INTO entries (scope_id, key, generation_id) VALUES (NEW.scope_id, NEW.key, NEW.generation_id)
    ON CONFLICT (scope_id, key) DO UPDATE SET generation_id = excluded.generation_id;
  INSERT INTO associations (scope_id, secondary_key, target_key) VALUES (NEW.scope_id, NEW.secondary_key, NEW.key)
    ON CONFLICT (scope_id, secondary_key) DO UPDATE SET target_key = excluded.target_key;
END;
