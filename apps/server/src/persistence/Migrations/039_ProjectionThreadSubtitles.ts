import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// fork: generated thread subtitles — persisted on the shell row so every
// client receives them without subscribing to full thread history.
//
// Some fork databases already recorded migration 37 before upstream assigned
// that id to the turn keyset index. Repeating the idempotent index creation here
// ensures those databases receive both schemas when they advance to 39.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "subtitle")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN subtitle TEXT
    `;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_turns_thread_keyset
    ON projection_turns(thread_id, requested_at, turn_id)
  `;
});
