import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The nonce a T3 Connect approval request binds into its code, and whether its device shows v2.
  yield* sql`ALTER TABLE auth_pairing_links ADD COLUMN connect_code_nonce TEXT`;
  yield* sql`ALTER TABLE auth_pairing_links ADD COLUMN connect_code_v2 INTEGER NOT NULL DEFAULT 0`;
});
