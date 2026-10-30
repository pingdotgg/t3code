-- Per-namespace opt-in for uploads from pull_request runs whose base is the registered branch.
-- Off by default: such uploads run unreviewed PR code, and default-branch builds restore their entries.
ALTER TABLE scopes ADD COLUMN pull_requests INTEGER NOT NULL DEFAULT 0 CHECK (pull_requests IN (0, 1));

-- Turning the opt-in off must also invalidate uploads that captured the previous policy.
DROP TRIGGER changed_policy;
CREATE TRIGGER changed_policy AFTER UPDATE OF endpoint, repository_id, repository_owner_id, branch,
  enabled, writes_enabled, pull_requests, retention_seconds, byte_limit, entry_limit, association_limit ON scopes
WHEN NEW.policy_version = OLD.policy_version
BEGIN
  UPDATE scopes SET policy_version = OLD.policy_version + 1 WHERE scope_id = NEW.scope_id;
END;
