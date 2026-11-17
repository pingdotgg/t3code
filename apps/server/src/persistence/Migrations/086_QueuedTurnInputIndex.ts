import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Shell counts subtract held input without reading a run's tool history or item payloads.
  yield* sql`
    CREATE INDEX orchestration_v2_projection_turn_items_queued_input_idx
    ON orchestration_v2_projection_turn_items(run_id)
    WHERE type = 'user_message'
      AND json_valid(payload_json)
      AND json_extract(payload_json, '$.inputIntent') = 'queued_turn'
  `;
});
