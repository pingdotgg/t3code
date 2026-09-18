---
"@effect/sql-sqlite-bun": patch
---

Allow database exports inside `withTransaction` to complete instead of waiting indefinitely. The exported snapshot
includes the transaction's uncommitted writes, while exports outside that transaction still wait for it to finish.
