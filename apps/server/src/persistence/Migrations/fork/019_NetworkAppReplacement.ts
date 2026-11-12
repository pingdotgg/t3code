import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The app of the network an invitation pairs again for; redeeming it removes that app.
  yield* sql`ALTER TABLE auth_pairing_links ADD COLUMN replaces_app_id TEXT`;
});
