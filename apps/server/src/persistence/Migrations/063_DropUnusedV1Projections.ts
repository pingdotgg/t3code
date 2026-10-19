import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * V2 databases start as a copy of the V1 database, and nothing reads these V1
 * projections after the copy. The V1 transcript import still reads threads,
 * messages and pull request links, so those stay. Builds before 0.1.0 read
 * `state.sqlite`, never this file, so dropping them does not affect a rollback.
 * The freed pages are reported as reclaimable space for `t3 doctor`.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DROP TABLE IF EXISTS projection_thread_activities`;
  yield* sql`DROP TABLE IF EXISTS projection_turns`;
  yield* sql`DROP TABLE IF EXISTS projection_thread_proposed_plans`;
  yield* sql`DROP TABLE IF EXISTS projection_pending_approvals`;
  yield* sql`DROP TABLE IF EXISTS projection_state`;
  yield* sql`DROP TABLE IF EXISTS checkpoint_diff_blobs`;
});
