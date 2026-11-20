import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_threads_subagent_parent_idx
    ON orchestration_v2_projection_threads(json_extract(payload_json, '$.lineage.parentThreadId'))
    WHERE deleted_at IS NULL
      AND CASE WHEN json_valid(payload_json)
        THEN json_extract(payload_json, '$.lineage.relationshipToParent') = 'subagent'
        ELSE 0 END
  `;
});
