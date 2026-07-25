import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Store pairing credentials as a hash instead of plaintext.
 *
 * Pending links cannot be carried across: their plaintext value only existed
 * so it could be redeemed, and hashing it here would require re-reading the
 * secret we are trying to stop storing. They are short-lived (minutes) and
 * single-use, so the cutover drops them and the user creates a new link.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(auth_pairing_links)
  `;
  if (columns.some((column) => column.name === "credential_hash")) {
    return;
  }

  yield* sql`DROP TABLE IF EXISTS auth_pairing_links`;

  yield* sql`
    CREATE TABLE auth_pairing_links (
      id TEXT PRIMARY KEY,
      credential_hash TEXT NOT NULL UNIQUE,
      method TEXT NOT NULL,
      scopes TEXT NOT NULL,
      subject TEXT NOT NULL,
      label TEXT,
      proof_key_thumbprint TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      revoked_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX idx_auth_pairing_links_active
    ON auth_pairing_links(revoked_at, consumed_at, expires_at)
  `;
});
