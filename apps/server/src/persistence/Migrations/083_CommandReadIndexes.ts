import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Every command reads its thread's nodes without the settled leaves. This index lets that read
  // seek the nodes it keeps instead of fetching each finished tool call to drop it. The
  // omitSettledLeafNodes read in ProjectionStore must spell this expression the same way.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_nodes_settled_leaf_idx
    ON orchestration_v2_projection_nodes(
      thread_id,
      (kind IN ('tool_call', 'assistant_message', 'reasoning')
        AND status IN ('completed', 'interrupted', 'failed', 'cancelled', 'rolled_back')
        AND run_id IS NOT NULL)
    )
  `;

  // A dispatcher thread is the source of thousands of consumed transfers. With status in the
  // index, a read of the pending ones no longer fetches each consumed row to check it.
  yield* sql`DROP INDEX IF EXISTS orchestration_v2_projection_context_transfers_source_thread_idx`;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_context_transfers_source_thread_status_idx
    ON orchestration_v2_projection_context_transfers(source_thread_id, status)
  `;
});
