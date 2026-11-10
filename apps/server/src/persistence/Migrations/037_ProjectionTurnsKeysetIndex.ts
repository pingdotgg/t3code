import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Keyset pagination needs both requested_at and turn_id indexed to avoid sorting all turns before LIMIT. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_turns_thread_keyset
    ON projection_turns(thread_id, requested_at, turn_id)
  `;
});
