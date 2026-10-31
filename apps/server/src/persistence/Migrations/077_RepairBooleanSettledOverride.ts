import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Thread projections may hold a boolean settledOverride, which the thread schema rejects.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE orchestration_v2_projection_threads
    SET payload_json = json_set(payload_json, '$.settledOverride',
      IIF(json_type(payload_json, '$.settledOverride') = 'true', 'settled', NULL))
    WHERE json_valid(payload_json)
      AND json_type(payload_json, '$.settledOverride') IN ('true', 'false')
  `;
});
