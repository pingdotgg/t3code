import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // What a run gave itself with `tags`, as a JSON array, so lists can be filtered by them.
  yield* sql`ALTER TABLE workflow_runs ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'`;
});
