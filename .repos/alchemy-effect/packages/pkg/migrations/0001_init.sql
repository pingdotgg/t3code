-- One row per tag. The tarball lives in R2 under <package>/<sha256>.tgz and
-- exists for as long as any row points at it.
--
-- expires_at is refreshed by every publication of the tag. linked_prs is the
-- JSON list of "owner/repo#N" pull requests whose runs produced the tag; the
-- sweep keeps those rows alive while any of them is open and pins expiry to
-- close time plus TTL once they all close. A mirrored commit tag is shared by
-- every pull request that pins that submodule commit, which is why this is
-- a list and not a column.
CREATE TABLE tags (
  package TEXT NOT NULL,
  tag TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  linked_prs TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (package, tag)
);
CREATE INDEX tags_expires_at ON tags (expires_at);
CREATE INDEX tags_sha256 ON tags (package, sha256);
