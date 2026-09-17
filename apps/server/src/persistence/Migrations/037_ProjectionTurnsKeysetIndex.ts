import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Composite index for windowed thread detail reads. Pagination orders turns by
 * the stable keyset (requested_at, turn_id); the pre-existing
 * (thread_id, requested_at) index cannot serve the tiebreak order, forcing a
 * temp B-tree over all of a thread's turns before the page LIMIT applies.
 * With this index the candidates scan is genuinely bounded by the page size.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_turns_thread_keyset
    ON projection_turns(thread_id, requested_at, turn_id)
  `;
});
