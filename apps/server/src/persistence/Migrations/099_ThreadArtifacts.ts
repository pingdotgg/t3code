import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE orchestration_v2_projection_artifacts (
      artifact_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      run_id TEXT,
      message_id TEXT,
      kind TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (thread_id, artifact_id)
    )
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_artifacts_thread_idx
    ON orchestration_v2_projection_artifacts(thread_id, created_at ASC, artifact_id ASC)
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_artifacts_run_idx
    ON orchestration_v2_projection_artifacts(run_id)
  `;
});
