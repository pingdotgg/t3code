import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const pairingLinkColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(auth_pairing_links)
  `;
  if (!pairingLinkColumns.some((column) => column.name === "requires_connect_approval")) {
    yield* sql`
      ALTER TABLE auth_pairing_links
      ADD COLUMN requires_connect_approval INTEGER NOT NULL DEFAULT 0
    `;
  }
  if (!pairingLinkColumns.some((column) => column.name === "requested_client_json")) {
    yield* sql`
      ALTER TABLE auth_pairing_links
      ADD COLUMN requested_client_json TEXT
    `;
  }

  const sessionColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(auth_sessions)
  `;
  if (!sessionColumns.some((column) => column.name === "proof_key_thumbprint")) {
    yield* sql`
      ALTER TABLE auth_sessions
      ADD COLUMN proof_key_thumbprint TEXT
    `;
  }

  yield* sql`
    CREATE TABLE IF NOT EXISTS auth_connect_devices (
      proof_key_thumbprint TEXT PRIMARY KEY,
      client_json TEXT,
      approved_at TEXT NOT NULL
    )
  `;
});
