import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The agent step's own turn, so cancelling its run stops that turn and not the whole thread.
  yield* sql`ALTER TABLE workflow_steps ADD COLUMN turn_id TEXT`;
});
