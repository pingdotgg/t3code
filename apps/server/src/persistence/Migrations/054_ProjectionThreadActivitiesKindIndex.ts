import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Index for reading activities of one kind across every thread. Startup
 * reconciles interrupted worktree setups that way before it accepts commands,
 * and the existing indexes all lead with thread_id, so the read scanned the
 * whole table and sorted it in a temp B-tree. The trailing columns match the
 * query's (created_at, activity_id) order, so rows come out of the index sorted.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_kind_created_id
    ON projection_thread_activities(kind, created_at, activity_id)
  `;
});
