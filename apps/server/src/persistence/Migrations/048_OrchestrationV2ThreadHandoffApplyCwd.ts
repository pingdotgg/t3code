import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Records the checkout a hop is being applied into.
 *
 * Startup recovery has to roll a half-applied hop back, and the thread it
 * belongs to may not exist yet — a first arrival that dies before its history
 * is written leaves no projection to read a working directory from. Storing
 * the directory on the hop itself makes the rollback independent of that.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE orchestration_v2_thread_handoffs ADD COLUMN apply_cwd TEXT
  `;
});
