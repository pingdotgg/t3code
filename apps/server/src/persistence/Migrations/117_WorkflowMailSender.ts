import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Who sent a kept signal and when, as the server saw it on receiving it. Null on one kept before.
  yield* sql`ALTER TABLE workflow_mail ADD COLUMN sender_json TEXT`;
});
