import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_synced_client_preferences (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      plan_mode_enabled INTEGER,
      appearance_mode TEXT,
      theme_id TEXT,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
    SELECT
      'projection.synced-client-preferences',
      COALESCE(MAX(sequence), 0),
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM orchestration_events
    WHERE true
    ON CONFLICT (projector) DO NOTHING
  `;
});
