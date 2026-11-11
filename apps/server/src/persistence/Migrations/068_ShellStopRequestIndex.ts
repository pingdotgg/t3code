import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX orchestration_v2_projection_turn_items_stop_request_idx
    ON orchestration_v2_projection_turn_items(thread_id, run_id)
    WHERE type = 'run_interrupt_request'
  `;
});
