import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DROP INDEX IF EXISTS idx_projection_threads_project_id`;
  yield* sql`DROP INDEX IF EXISTS idx_projection_thread_activities_thread_created`;
});
