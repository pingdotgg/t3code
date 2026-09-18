---
"@effect/sql-pg": patch
---

Allow each PostgreSQL pool connection to complete its first checkout before applying `connectionTTL`, so a zero TTL
disables connection reuse without entering an invalidate/reconnect loop.
