import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const pairingLinkColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(auth_pairing_links)
  `;
  if (!pairingLinkColumns.some((column) => column.name === "connect_denied")) {
    yield* sql`
      ALTER TABLE auth_pairing_links
      ADD COLUMN connect_denied INTEGER NOT NULL DEFAULT 0
    `;
  }
});
