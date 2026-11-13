import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Pruned lifecycle events cannot establish complete membership; historical forks keep the timestamp fallback.
  yield* sql`ALTER TABLE orchestration_v2_projection_threads ADD COLUMN fork_run_ids_json TEXT`;
});
