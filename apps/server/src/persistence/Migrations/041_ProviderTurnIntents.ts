import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_turn_intents (
      event_sequence INTEGER PRIMARY KEY,
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      requested_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_turn_intents_thread_sequence
    ON provider_turn_intents(thread_id, event_sequence)
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_turn_intents_one_per_thread
    ON provider_turn_intents(thread_id)
  `;
});
