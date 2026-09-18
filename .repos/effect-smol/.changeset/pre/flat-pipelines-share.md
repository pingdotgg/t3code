---
"@effect/sql-pg": patch
---

Set the default `multiplexConcurrency` to 32 when PostgreSQL connection multiplexing is enabled. Set a lower value explicitly to limit how many statements share each connection.
