import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // What a workflow tags its run with, as a JSON list, for filtering runs.
  yield* sql`ALTER TABLE workflow_runs ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'`;
});
