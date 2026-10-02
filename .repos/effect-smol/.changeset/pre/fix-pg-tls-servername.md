---
"@effect/sql-pg": patch
---

Default TLS servername to the hostname for non-IP hosts during connection startup and cancellation, restoring connections to Postgres endpoints that require SNI. Preserve explicit SSL servername overrides.
