import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A history page indexes every item of its thread. These carry the columns that read needs, so
  // it stays in the indexes instead of fetching each row and node next to megabytes of payload.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_turn_items_timeline_idx
    ON orchestration_v2_projection_turn_items(
      thread_id, ordinal, turn_item_id, run_id, node_id, parent_item_id, type, status
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_nodes_root_idx
    ON orchestration_v2_projection_nodes(node_id, root_node_id)
  `;
});
