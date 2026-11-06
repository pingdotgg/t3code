import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Each lets a read of one long thread skip the rows it does not return. Every column a query
  // could match is wrapped in `|| ''`, so only a lookup that writes the same expression can use
  // them. Plain indexes were chosen for unrelated statements over their partial indexes.
  yield* sql`
    CREATE INDEX orchestration_v2_projection_turn_items_thread_type_idx
    ON orchestration_v2_projection_turn_items((thread_id || ''), (type || ''), ordinal, turn_item_id)
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_runs_id_status_idx
    ON orchestration_v2_projection_runs((run_id || ''), status)
  `;
});
