import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE bot_workflow_triggers (
      task_id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL REFERENCES bot_collections(id)
    )
  `;
});
