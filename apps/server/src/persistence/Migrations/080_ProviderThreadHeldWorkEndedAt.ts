import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Rows start out holding nothing: restart recovery clears every roster before new turns run.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE orchestration_v2_projection_provider_threads ADD COLUMN holds_completion INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE orchestration_v2_projection_provider_threads ADD COLUMN held_work_ended_at TEXT`;
});
