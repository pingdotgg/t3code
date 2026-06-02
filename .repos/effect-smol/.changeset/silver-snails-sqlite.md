---
"effect": patch
"@effect/sql-libsql": patch
"@effect/sql-mssql": patch
"@effect/sql-mysql2": patch
"@effect/sql-pg": patch
"@effect/sql-pglite": patch
"@effect/sql-sqlite-bun": patch
"@effect/sql-sqlite-do": patch
"@effect/sql-sqlite-node": patch
"@effect/sql-sqlite-react-native": patch
"@effect/sql-sqlite-wasm": patch
---

Add `UniqueViolation` as a new SQL error reason. Supported unique constraint violations now classify as `UniqueViolation` instead of the broader `ConstraintError` reason.

This covers PostgreSQL, PGlite, MySQL, MSSQL, and the shared SQLite classification used by the SQLite-family clients. `UniqueViolation.constraint` contains the best available constraint, index, or key identifier and falls back to exactly `"unknown"` when no reliable identifier is available.
