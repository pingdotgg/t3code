import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Typed command reads; without this, each one walked every item in the thread.
  yield* sql`
    CREATE INDEX orchestration_v2_projection_turn_items_thread_type_idx
    ON orchestration_v2_projection_turn_items(thread_id, type, ordinal, turn_item_id)
  `;
  // Lets provider-thread ownership start from one thread's node ids without reading node rows.
  yield* sql`
    CREATE INDEX orchestration_v2_projection_nodes_thread_node_idx
    ON orchestration_v2_projection_nodes(thread_id, node_id)
  `;
  // Keep these expressions aligned with ProjectionStore's message ordering and
  // omitSettledLeafNodes reads.
  yield* sql`
    CREATE INDEX orchestration_v2_projection_turn_items_message_idx
    ON orchestration_v2_projection_turn_items(
      thread_id, json_extract(payload_json, '$.messageId'), ordinal
    )
    WHERE type IN ('user_message', 'assistant_message')
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_nodes_settled_leaf_idx
    ON orchestration_v2_projection_nodes(
      thread_id,
      (kind IN ('tool_call', 'assistant_message', 'reasoning')
        AND status IN ('completed', 'interrupted', 'failed', 'cancelled', 'rolled_back')
        AND run_id IS NOT NULL)
    )
  `;
});
