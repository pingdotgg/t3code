import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The thread window finds its newest conversation rows here instead of walking the tool calls
  // between them. The read in ProjectionStore must spell this type list the same way.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_turn_items_conversation_idx
    ON orchestration_v2_projection_turn_items(thread_id, ordinal, type, run_id)
    WHERE type NOT IN (
      'command_execution', 'reasoning', 'file_change', 'file_search', 'web_search', 'dynamic_tool'
    )
  `;
});
