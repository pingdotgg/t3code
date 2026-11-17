import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Databases that ran migration 86 before its json_valid guard reject malformed user messages.
  yield* sql`DROP INDEX IF EXISTS orchestration_v2_projection_turn_items_queued_input_idx`;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_turn_items_queued_input_idx
    ON orchestration_v2_projection_turn_items(run_id)
    WHERE type = 'user_message'
      AND json_valid(payload_json)
      AND json_extract(payload_json, '$.inputIntent') = 'queued_turn'
  `;
});
