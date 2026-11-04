import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The auto-archive sweep reads settled, unarchived threads by settle time. The
// partial index holds only those rows, and the sweep's WHERE must repeat its
// predicate verbatim for SQLite to use it.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_threads_settled_at_idx
    ON orchestration_v2_projection_threads(json_extract(payload_json, '$.settledAt'))
    WHERE deleted_at IS NULL
      AND archived_at IS NULL
      AND json_extract(payload_json, '$.settledOverride') = 'settled'
  `;
});
