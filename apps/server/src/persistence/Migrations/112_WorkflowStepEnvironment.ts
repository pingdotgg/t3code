import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The linked environment an agent step's thread is in; null for this one.
  yield* sql`ALTER TABLE workflow_steps ADD COLUMN environment_id TEXT`;
});
