---
"@effect/sql-sqlite-wasm": patch
---

Preserve native SQLite error codes in OPFS worker replies so the client can classify constraint failures as `ConstraintError` instead of `UnknownError`. For coded worker failures, `SqlError.reason.cause` now contains a `{ message, code }` record instead of a string.
