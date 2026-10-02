import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Later ordering indexes contain these exact column prefixes, so SQLite can
  // serve the same lookups without maintaining a second B-tree on every write.
  yield* sql`DROP INDEX IF EXISTS idx_projection_threads_project_id`;
  yield* sql`DROP INDEX IF EXISTS idx_projection_thread_messages_thread_created`;
  yield* sql`DROP INDEX IF EXISTS idx_projection_thread_activities_thread_sequence`;
  yield* sql`DROP INDEX IF EXISTS idx_projection_turns_thread_requested`;
});
