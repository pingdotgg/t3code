import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * This is an intentional alpha cutover: role-bearing credentials and sessions
 * cannot safely be assigned new capabilities implicitly.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

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
    CREATE INDEX idx_auth_sessions_active
    ON auth_sessions(revoked_at, expires_at, issued_at)
  `;
});
