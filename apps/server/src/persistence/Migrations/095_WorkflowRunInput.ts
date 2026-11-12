import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // What a run was started with, for the cleanup of a run that was cancelled: its body is gone
  // by then, and the engine's own copy is not ours to read.
  yield* sql`ALTER TABLE workflow_runs ADD COLUMN input_json TEXT`;
});
