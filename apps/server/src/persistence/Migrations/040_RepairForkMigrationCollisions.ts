import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Fork releases used migration IDs 37 and 38 for thread subtitles before
 * upstream assigned those IDs to the turn keyset index and pin ordering.
 * Migrator advances by numeric ID, so those databases cannot discover the
 * missing upstream schema by replaying the renamed migrations. Repair every
 * colliding addition idempotently at the next free ID instead.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "pin_order_key")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN pin_order_key TEXT
    `;
  }

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
