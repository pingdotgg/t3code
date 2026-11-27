-- Keep several entries per key (RFC 0003). Cache data is disposable, so the cache tables are
-- recreated empty. Namespace registrations, policy and limits stay. The R2 bucket's lifecycle rules
-- delete the old objects; empty the bucket to get their bytes back sooner.
DROP TABLE entries;
DROP TABLE associations;
DROP TABLE generations;
UPDATE maintenance SET scope_id = '', secondary_key = X'' WHERE id = 1;
UPDATE scopes SET charged_bytes = 0, entry_count = 0, association_count = 0;
UPDATE deployment SET charged_bytes = 0, entry_count = 0, association_count = 0;
-- How many of a key's newest entries a namespace keeps.
ALTER TABLE scopes ADD COLUMN entries_per_key INTEGER NOT NULL DEFAULT 8 CHECK (entries_per_key BETWEEN 1 AND 16);

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
-- One row per live entry. A key can have up to `entries_per_key` of them. `seq` numbers a key's
-- publications in order, so the newest entries sort first even within one second.
CREATE TABLE entries (
  scope_id TEXT NOT NULL REFERENCES scopes(scope_id),
  key BLOB NOT NULL CHECK (typeof(key) = 'blob'),
  generation_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (scope_id, key, generation_id),
  FOREIGN KEY (scope_id, generation_id) REFERENCES generations(scope_id, generation_id) ON DELETE CASCADE
) WITHOUT ROWID;
CREATE INDEX entries_generation ON entries(generation_id);
CREATE UNIQUE INDEX entries_seq ON entries(scope_id, key, seq);
CREATE TABLE associations (
  scope_id TEXT NOT NULL REFERENCES scopes(scope_id),
  secondary_key BLOB NOT NULL CHECK (typeof(secondary_key) = 'blob'),
  target_key BLOB NOT NULL CHECK (typeof(target_key) = 'blob'),
  PRIMARY KEY (scope_id, secondary_key)
) WITHOUT ROWID;
CREATE INDEX associations_target ON associations(scope_id, target_key);

-- Parenthesize CASE expressions so the D1 REST parser preserves each trigger body.
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

-- `entry_limit` counts keys: a key's first entry counts it, and deleting its last entry uncounts it.
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
CREATE TRIGGER uncount_entry AFTER DELETE ON entries
WHEN NOT EXISTS (SELECT 1 FROM entries WHERE scope_id = OLD.scope_id AND key = OLD.key)
BEGIN
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
-- Publication adds an entry, then retires the key's live entries past its newest `entries_per_key`.
-- Only live entries are ranked: after a retention cut a newer entry can expire before an older one,
-- and an expired row Cron hasn't removed yet must not push a live entry out.
CREATE TRIGGER publish_generation AFTER UPDATE OF state ON generations
WHEN OLD.state = 'uploading' AND NEW.state = 'ready'
BEGIN
  INSERT INTO entries (scope_id, key, generation_id, seq)
    VALUES (NEW.scope_id, NEW.key, NEW.generation_id,
      (SELECT coalesce(max(seq), 0) + 1 FROM entries WHERE scope_id = NEW.scope_id AND key = NEW.key));
  UPDATE generations SET state = 'retired', retired_at = unixepoch(),
    gc_after = (CASE WHEN expires_at > unixepoch() THEN unixepoch() + 600 ELSE unixepoch() END)
    WHERE generation_id IN (
      SELECT g.generation_id FROM entries e JOIN generations g ON g.generation_id = e.generation_id
      WHERE e.scope_id = NEW.scope_id AND e.key = NEW.key AND g.state = 'ready' AND g.expires_at > unixepoch()
      ORDER BY e.seq DESC
      LIMIT -1 OFFSET (SELECT entries_per_key FROM scopes WHERE scope_id = NEW.scope_id));
  DELETE FROM entries WHERE scope_id = NEW.scope_id AND key = NEW.key AND generation_id IN (
    SELECT g.generation_id FROM entries e JOIN generations g ON g.generation_id = e.generation_id
    WHERE e.scope_id = NEW.scope_id AND e.key = NEW.key AND g.state = 'retired');
  INSERT INTO associations (scope_id, secondary_key, target_key) VALUES (NEW.scope_id, NEW.secondary_key, NEW.key)
    ON CONFLICT (scope_id, secondary_key) DO UPDATE SET target_key = excluded.target_key;
END;
