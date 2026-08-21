import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_thread_user_input_lifecycle
    ON projection_thread_activities(thread_id, kind, created_at, activity_id)
    WHERE kind IN (
      'user-input.requested',
      'user-input.resolved',
      'provider.user-input.respond.failed'
    )
  `;
});
