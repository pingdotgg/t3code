import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Keep this predicate identical to ProjectionStore.getThreadsWithPullRequests.
  // json_valid keeps a malformed payload writable, as the other payload indexes do.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_threads_pull_request_poll_idx
    ON orchestration_v2_projection_threads(updated_at, thread_id)
    WHERE deleted_at IS NULL
      AND CASE WHEN json_valid(payload_json) THEN
        json_extract(payload_json, '$.archivedAt') IS NULL
        AND json_array_length(payload_json, '$.pullRequests') > 0
        ELSE 0 END
  `;
});
