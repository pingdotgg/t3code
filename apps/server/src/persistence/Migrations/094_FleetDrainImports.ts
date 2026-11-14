import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Drained thread bundles imported as archived threads: one row per imported
  // thread, keyed by thread id, carrying the currency marker (environment,
  // drain id, snapshot sequence) that decides idempotency and supersession.
  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_v2_fleet_drain_imports (
      thread_id TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL,
      drain_id TEXT NOT NULL,
      snapshot_sequence INTEGER,
      imported_at TEXT NOT NULL,
      lossy INTEGER NOT NULL DEFAULT 0,
      oversize_attachments_skipped INTEGER NOT NULL DEFAULT 0
    )
  `;
});
