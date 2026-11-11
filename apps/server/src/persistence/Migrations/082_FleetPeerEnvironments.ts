import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Peer t3 instances this environment knows as a fleet: the managing instance
  // itself and the workers it delegates to. The delegation session token is
  // kept in the server secret store under `secret_name`, like a peer link.
  yield* sql`
    CREATE TABLE IF NOT EXISTS fleet_peer_environments (
      environment_id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      label TEXT NOT NULL,
      urls_json TEXT NOT NULL,
      worker_class TEXT,
      secret_name TEXT,
      session_scopes_json TEXT,
      session_expires_at TEXT,
      registered_at TEXT NOT NULL,
      last_error TEXT
    )
  `;
});
