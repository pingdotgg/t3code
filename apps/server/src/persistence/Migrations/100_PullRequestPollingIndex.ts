import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_threads_pull_request_poll_idx
    ON orchestration_v2_projection_threads(updated_at, thread_id)
    WHERE deleted_at IS NULL
      AND json_extract(payload_json, '$.archivedAt') IS NULL
      AND json_array_length(payload_json, '$.pullRequests') > 0
  `;
});
