import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS activity_payload_blobs (
      activity_id TEXT PRIMARY KEY,
      data_json TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS activity_payload_compaction_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      last_sequence INTEGER NOT NULL
    )
  `;

  yield* sql`
    INSERT INTO activity_payload_compaction_state (singleton, last_sequence)
    VALUES (1, 0)
    ON CONFLICT (singleton) DO NOTHING
  `;
});
