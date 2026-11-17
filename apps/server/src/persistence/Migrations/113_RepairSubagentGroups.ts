import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE orchestration_v2_projection_threads
    SET payload_json = json_remove(payload_json, '$.group')
    WHERE json_valid(payload_json)
      AND json_extract(payload_json, '$.lineage.relationshipToParent') = 'subagent'
      AND json_type(payload_json, '$.group') = 'object'
  `;
});
