import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Records whether a hop created its worktree.
 *
 * A hop that provisions a worktree and then dies leaves it holding the
 * branch. Retries derive the same path from the handoff id, so without
 * knowing the worktree was this hop's to remove, recovery leaves it in
 * place and every retry fails on the occupied directory.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE orchestration_v2_thread_handoffs ADD COLUMN created_worktree INTEGER NOT NULL DEFAULT 0
  `;
});
