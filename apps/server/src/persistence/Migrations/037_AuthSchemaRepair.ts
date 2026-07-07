import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

interface TableColumn {
  readonly name: string;
}

function hasColumn(columns: ReadonlyArray<TableColumn>, name: string): boolean {
  return columns.some((column) => column.name === name);
}

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const pairingColumns = yield* sql<TableColumn>`
    PRAGMA table_info(auth_pairing_links)
  `;
  const sessionColumns = yield* sql<TableColumn>`
    PRAGMA table_info(auth_sessions)
  `;

  const needsScopedAuthRebuild =
    pairingColumns.length === 0 ||
    sessionColumns.length === 0 ||
    !hasColumn(pairingColumns, "scopes") ||
    !hasColumn(sessionColumns, "scopes") ||
    hasColumn(pairingColumns, "role") ||
    hasColumn(sessionColumns, "role");

  if (needsScopedAuthRebuild) {
    yield* sql`DROP TABLE IF EXISTS auth_pairing_links`;
    yield* sql`DROP TABLE IF EXISTS auth_sessions`;

    yield* sql`
      CREATE TABLE auth_pairing_links (
        id TEXT PRIMARY KEY,
        credential TEXT NOT NULL UNIQUE,
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
      CREATE INDEX IF NOT EXISTS idx_auth_pairing_links_active
      ON auth_pairing_links(revoked_at, consumed_at, expires_at)
    `;

    yield* sql`
      CREATE TABLE auth_sessions (
        session_id TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        scopes TEXT NOT NULL,
        method TEXT NOT NULL,
        client_label TEXT,
        client_ip_address TEXT,
        client_user_agent TEXT,
        client_device_type TEXT NOT NULL DEFAULT 'unknown',
        client_os TEXT,
        client_browser TEXT,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_connected_at TEXT,
        revoked_at TEXT
      )
    `;

    yield* sql`
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_active
      ON auth_sessions(revoked_at, expires_at, issued_at)
    `;

    return;
  }

  if (!hasColumn(pairingColumns, "proof_key_thumbprint")) {
    yield* sql`
      ALTER TABLE auth_pairing_links
      ADD COLUMN proof_key_thumbprint TEXT
    `;
  }
});
