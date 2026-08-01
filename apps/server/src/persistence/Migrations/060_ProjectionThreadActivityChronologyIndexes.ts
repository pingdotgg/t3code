import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_thread_chronology
    ON projection_thread_activities(thread_id, created_at DESC, activity_id DESC)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_thread_kind_created
    ON projection_thread_activities(thread_id, kind, created_at DESC, activity_id DESC)
  `;
});
