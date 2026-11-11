import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Awareness rollups load direct side-chat children by parentThreadId.
  yield* sql`
    CREATE INDEX orchestration_v2_projection_threads_side_chat_parent_idx
    ON orchestration_v2_projection_threads(
      json_extract(payload_json, '$.lineage.parentThreadId'),
      thread_id
    )
    WHERE CASE WHEN json_valid(payload_json) THEN
      json_extract(payload_json, '$.lineage.sideChat') = 1
      AND json_extract(payload_json, '$.lineage.parentThreadId') IS NOT NULL
      ELSE 0 END
  `;
});
