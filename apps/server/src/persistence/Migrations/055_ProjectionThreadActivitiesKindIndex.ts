import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Thread shell summaries refresh on every session change and look up a thread's user-input
// activities by kind. Without this index that lookup visits every activity row in the thread.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_thread_kind
    ON projection_thread_activities(thread_id, kind)
  `;
});
