CREATE TABLE receipts (id TEXT PRIMARY KEY, recorded_at INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE savings (
  developer TEXT NOT NULL,
  host TEXT NOT NULL,
  platform TEXT NOT NULL,
  arch TEXT NOT NULL,
  ci INTEGER NOT NULL,
  local_ms INTEGER NOT NULL,
  remote_ms INTEGER NOT NULL,
  local_hits INTEGER NOT NULL,
  remote_hits INTEGER NOT NULL,
  executed INTEGER NOT NULL,
  restore_failures INTEGER NOT NULL,
  PRIMARY KEY (developer, host, platform, arch, ci)
) WITHOUT ROWID;
CREATE INDEX receipts_age ON receipts(recorded_at);
