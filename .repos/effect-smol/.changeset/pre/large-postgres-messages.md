---
"@effect/sql-pg": patch
---

Add a `maxMessageSize` connection option so PostgreSQL clients can receive backend messages larger than the 16 MiB default.
