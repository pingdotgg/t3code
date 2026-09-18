---
"@effect/sql-sqlite-bun": patch
"@effect/sql-sqlite-node": patch
---

Allow read-only SQLite clients to use `withTransaction` when `PRAGMA query_only` is enabled. Writable clients continue
to reserve the writer lock when a transaction starts.
