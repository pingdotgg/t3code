import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Runs a read-then-write transaction so a second server process sharing this
 * database cannot fail it midway.
 *
 * Under a deferred BEGIN, a commit from another connection between the first
 * read and the first write makes the write fail at once with
 * SQLITE_BUSY_SNAPSHOT; busy_timeout is never consulted. Executing a write
 * statement first takes the write lock before any read, so competing writers
 * wait on busy_timeout instead. Read-only transactions should keep using
 * `sql.withTransaction`, which never contends for the write lock.
 */
export const withWriteTransaction = <A, E, R>(
  sql: SqlClient.SqlClient,
  effect: Effect.Effect<A, E, R>,
) =>
  sql.withTransaction(sql`DELETE FROM orchestration_events WHERE 0`.pipe(Effect.andThen(effect)));
