import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // What a step produced, for a person reading the run. The engine keeps its own copy to replay.
  yield* sql`ALTER TABLE workflow_steps ADD COLUMN result_json TEXT`;
  // An agent that returns data also says something at the end; a person reads that first.
  yield* sql`ALTER TABLE workflow_steps ADD COLUMN said TEXT`;
});
