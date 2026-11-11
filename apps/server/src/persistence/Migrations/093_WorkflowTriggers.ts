import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // When each schedule trigger is next due.
  yield* sql`
    CREATE TABLE workflow_triggers (
      trigger_id TEXT PRIMARY KEY,
      next_at TEXT NOT NULL
    )
  `;
  // The secret half of each workflow hook's URL.
  yield* sql`
    CREATE TABLE workflow_hooks (
      hook_id TEXT PRIMARY KEY,
      token TEXT NOT NULL
    )
  `;
});
