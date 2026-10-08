import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A bounded thread snapshot finds its turn boundary from the newest user
  // messages. Without this index it reads every turn item in the thread to
  // find a few dozen of them. ProjectionStore's turn_anchors CTE relies on it.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_turn_items_user_message_idx
    ON orchestration_v2_projection_turn_items(thread_id, ordinal, turn_item_id)
    WHERE type = 'user_message'
  `;
  // The same snapshot keeps every unfinished node. A long thread has thousands
  // of finished ones, and reading them all to find a few live ones was more
  // than half of the node query's time.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_nodes_live_idx
    ON orchestration_v2_projection_nodes(thread_id)
    WHERE status IN ('pending', 'starting', 'running', 'waiting')
  `;
});
