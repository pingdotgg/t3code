import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // What the engine itself looks at to end this wait, such as a pull request's checks.
  yield* sql`ALTER TABLE workflow_waits ADD COLUMN watch_json TEXT`;
  // What a wait was woken with, kept until the run is past it, so a wake lost to a crash is redone.
  yield* sql`ALTER TABLE workflow_waits ADD COLUMN woke_json TEXT`;
});
