import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Compatibility repair for databases where migration ID 20 was already consumed
// before auth access tables were introduced. This recreates the intended schema
// without disturbing databases that already applied the auth migrations normally.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS auth_pairing_links (
      id TEXT PRIMARY KEY,
      credential TEXT NOT NULL UNIQUE,
      method TEXT NOT NULL,
      role TEXT NOT NULL,
      subject TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      revoked_at TEXT,
      label TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_auth_pairing_links_active
    ON auth_pairing_links(revoked_at, consumed_at, expires_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS auth_sessions (
      session_id TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      role TEXT NOT NULL,
      method TEXT NOT NULL,
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      client_label TEXT,
      client_ip_address TEXT,
      client_user_agent TEXT,
      client_device_type TEXT NOT NULL DEFAULT 'unknown',
      client_os TEXT,
      client_browser TEXT,
      last_connected_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_active
    ON auth_sessions(revoked_at, expires_at, issued_at)
  `;
});
