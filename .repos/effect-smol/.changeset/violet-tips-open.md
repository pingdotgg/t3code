---
"@effect/sql-pg": patch
---

Fix `PgClient.makeClient` to connect the underlying `pg.Client` during resource acquisition.
