import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // threads_project_linked_idx from 077 stays because getThreadsWithPullRequests scans it.
  yield* sql`DROP INDEX IF EXISTS orchestration_v2_projection_runs_thread_requested_idx`;
  yield* sql`DROP INDEX IF EXISTS orchestration_v2_projection_runs_thread_completed_idx`;
  yield* sql`DROP INDEX IF EXISTS orchestration_v2_projection_checkpoints_thread_captured_idx`;
  yield* sql`DROP INDEX IF EXISTS orchestration_v2_projection_turn_items_run_command_updated_idx`;
  yield* sql`DROP INDEX IF EXISTS orchestration_v2_projection_turn_items_run_updated_idx`;
  yield* sql`DROP INDEX IF EXISTS orchestration_v2_projection_turn_items_run_command_at_idx`;
});
