import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

/**
 * Adds `forked_from_thread_id` to projection_threads: the id of the predecessor
 * thread a fork branched from (NULL for ordinary threads). Drives the
 * linked-fork sidebar UI. No backfill — forking did not exist before this.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN forked_from_thread_id TEXT
  `.pipe(Effect.catch(() => Effect.void));
});
