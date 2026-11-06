import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Lifecycle of gateway-managed worker environments, tracked here so state
  // survives a restart of the managing instance (spec section 5.5). Drain
  // progress is the aggregate journal view; per-item acks land with the drain
  // protocol itself.
  yield* sql`
    CREATE TABLE IF NOT EXISTS openshell_fleet_environments (
      environment_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      worker_class TEXT NOT NULL,
      label TEXT,
      sandbox_name TEXT,
      sandbox_id TEXT,
      drain_json TEXT,
      expires_at INTEGER,
      last_error TEXT,
      updated_at TEXT NOT NULL
    )
  `;
});
