import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Later indexes cover the same column prefixes; avoid maintaining duplicate B-trees.
  yield* sql`DROP INDEX IF EXISTS idx_projection_threads_project_id`;
  yield* sql`DROP INDEX IF EXISTS idx_projection_thread_messages_thread_created`;
  yield* sql`DROP INDEX IF EXISTS idx_projection_thread_activities_thread_sequence`;
  yield* sql`DROP INDEX IF EXISTS idx_projection_turns_thread_requested`;
});
