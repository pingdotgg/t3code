import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // One row per plugin installation that receives events: the event log sequence it has
  // acknowledged through. Removing the installation removes its row.
  yield* sql`
    CREATE TABLE IF NOT EXISTS plugin_event_cursors (
      installation_id TEXT PRIMARY KEY,
      acknowledged_sequence INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
