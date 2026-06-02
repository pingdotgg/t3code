---
"@effect/sql-pg": patch
---

Use a dedicated PostgreSQL client for LISTEN / UNLISTEN subscriptions instead of checking out a pooled connection for the listener lifecycle.
