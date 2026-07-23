---
"@effect/sql-pg": patch
---

Guard transaction connection acquisition in `PgClient.fromPool` so acquire failures stay in the `SqlError` channel.
