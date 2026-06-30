import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS auth_connect_clients (
      client_proof_key_thumbprint TEXT PRIMARY KEY,
      cloud_user_id TEXT NOT NULL,
      device_id TEXT,
      status TEXT NOT NULL,
      client_label TEXT,
      client_ip_address TEXT,
      client_user_agent TEXT,
      client_device_type TEXT NOT NULL DEFAULT 'unknown',
      client_os TEXT,
      client_browser TEXT,
      requested_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      approved_at TEXT,
      rejected_at TEXT,
      revoked_at TEXT,
      last_seen_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_auth_connect_clients_active
    ON auth_connect_clients(revoked_at, status, updated_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_auth_connect_clients_cloud_user
    ON auth_connect_clients(cloud_user_id, revoked_at)
  `;
});
