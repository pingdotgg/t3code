---
"@effect/sql-sqlite-do": patch
---

Support Cloudflare Durable Object SQLite transactions by allowing `SqliteClient` to be configured with `DurableObjectStorage` and routing `withTransaction` through `storage.transaction`.
