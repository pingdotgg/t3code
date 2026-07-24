import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Queues legacy soft-deleted threads for the same permanent cleanup as new deletes. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_cleanup_queue (
      thread_id TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    )
  `;

  yield* sql`
    INSERT OR IGNORE INTO thread_cleanup_queue (thread_id, reason, created_at)
    SELECT thread_id, 'deleted', CURRENT_TIMESTAMP
    FROM projection_threads
    WHERE deleted_at IS NOT NULL
  `;
});
