import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Recovery's provider-thread read looks up unfinished items of any type, which
  // the type-filtered recovery index cannot serve.
  yield* sql`
    CREATE INDEX orchestration_v2_projection_turn_items_unfinished_idx
    ON orchestration_v2_projection_turn_items(thread_id)
    WHERE status IN ('pending', 'running', 'waiting')
  `;
});
