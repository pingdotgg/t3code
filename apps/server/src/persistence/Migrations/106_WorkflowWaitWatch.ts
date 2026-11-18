import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // What the engine itself looks at to end this wait, such as a pull request's checks.
  yield* sql`ALTER TABLE workflow_waits ADD COLUMN watch_json TEXT`;
});
