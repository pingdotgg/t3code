import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE orchestration_v2_agent_session_import_sources (
      thread_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      source_json TEXT NOT NULL,
      PRIMARY KEY (thread_id, file_path)
    )
  `;
});
