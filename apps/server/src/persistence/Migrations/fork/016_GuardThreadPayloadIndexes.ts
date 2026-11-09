import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Index expressions run on every write, and json_extract throws on malformed JSON, so an
// unguarded index turns one bad payload into a failed write. Upstream 079 guards the same way.
// Queries must repeat each guarded expression verbatim for SQLite to use the index.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DROP INDEX IF EXISTS orchestration_v2_projection_threads_parent_idx`;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_threads_parent_idx
    ON orchestration_v2_projection_threads(
      CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.parentThreadId') END
    )
  `;

  yield* sql`DROP INDEX IF EXISTS orchestration_v2_projection_threads_settled_at_idx`;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_threads_settled_at_idx
    ON orchestration_v2_projection_threads(json_extract(payload_json, '$.settledAt'))
    WHERE deleted_at IS NULL
      AND archived_at IS NULL
      AND CASE WHEN json_valid(payload_json)
        THEN json_extract(payload_json, '$.settledOverride') = 'settled'
        ELSE 0 END
  `;
});
