---
"@effect/sql-pg": patch
---

Use `pg_notify` in `PgClient.notify` so channel and payload are sent through parameters instead of a `NOTIFY` statement string.
