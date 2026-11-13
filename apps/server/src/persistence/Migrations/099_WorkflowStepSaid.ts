import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // An agent that returns data also says something at the end; a person reads that first.
  yield* sql`ALTER TABLE workflow_steps ADD COLUMN said TEXT`;
});
