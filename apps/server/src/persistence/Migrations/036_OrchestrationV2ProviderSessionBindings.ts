import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE orchestration_v2_projection_provider_session_bindings (
      provider_session_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      PRIMARY KEY (provider_session_id, thread_id)
    )
  `;
  yield* sql`
    INSERT OR IGNORE INTO orchestration_v2_projection_provider_session_bindings (
      provider_session_id,
      thread_id
    )
    SELECT provider_session_id, thread_id
    FROM orchestration_v2_projection_provider_sessions
    WHERE thread_id IS NOT NULL
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_provider_session_bindings_thread_idx
    ON orchestration_v2_projection_provider_session_bindings(thread_id)
  `;
});
