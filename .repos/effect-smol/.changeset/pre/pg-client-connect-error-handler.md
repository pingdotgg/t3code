---
"@effect/sql-pg": patch
---

Prevent unhandled `pg` client error events while `PgClient.makeClient` is connecting.
