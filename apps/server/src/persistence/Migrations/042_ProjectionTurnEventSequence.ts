import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Existing singleton pending rows deliberately remain NULL. They predate
  // durable provider intents and must not be adopted by a future runtime turn.
  yield* sql`
    ALTER TABLE projection_turns
    ADD COLUMN event_sequence INTEGER
  `;

  yield* sql`
    CREATE TABLE projection_turn_event_sequence_rollout (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      cutoff_sequence INTEGER NOT NULL
    )
  `;

  yield* sql`
    INSERT INTO projection_turn_event_sequence_rollout (singleton, cutoff_sequence)
    SELECT 1, COALESCE(MAX(sequence), 0)
    FROM orchestration_events
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_projection_turns_event_sequence
    ON projection_turns(event_sequence)
    WHERE event_sequence IS NOT NULL
  `;
});
