import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

/**
 * `ADD COLUMN` on a database that already has the column is the only failure
 * this migration expects; anything else (locked db, disk full, corruption)
 * must fail the migration instead of being silently swallowed.
 */
const ignoreDuplicateColumn = (error: SqlError) => {
  const cause = error.reason.cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.includes("duplicate column name") ? Effect.void : Effect.fail(error);
};

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN forked_from_thread_id TEXT
  `.pipe(Effect.catch(ignoreDuplicateColumn));
  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN forked_at TEXT
  `.pipe(Effect.catch(ignoreDuplicateColumn));
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_forked_from_thread_id
    ON projection_threads(forked_from_thread_id)
  `;
});
