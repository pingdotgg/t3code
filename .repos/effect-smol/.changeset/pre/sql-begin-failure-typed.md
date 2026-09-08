---
"effect": patch
---

Propagate a failed `BEGIN` or `SAVEPOINT` from `SqlClient.withTransaction` as a typed `SqlError`.

`makeWithTransaction` wrapped the `begin` step together with the transaction body, so a
failed `BEGIN` took the rollback branch. No transaction was active at that point, the
`ROLLBACK` failed, and its `Effect.orDie` wrapper replaced the original typed error with a
defect (`cannot rollback - no transaction is active`). Callers could no longer classify the
failure as retryable. The path became reachable when the sqlite client started using
`BEGIN IMMEDIATE`, which acquires a write lock and can fail with `SQLITE_BUSY`.

Commit and rollback now run only after `begin` or `savepoint` succeeds. A failed `begin` or
`savepoint` fails with its original `SqlError`, leaves the wrapped effect unexecuted, and
still closes the acquired connection scope.
