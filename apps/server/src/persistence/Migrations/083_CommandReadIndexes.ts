import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The settled-leaf index on nodes moved to DeferredIndexes, which builds it without holding up startup.

  // A dispatcher thread is the source of thousands of consumed transfers. With status in the
  // index, a read of the pending ones no longer fetches each consumed row to check it.
  yield* sql`DROP INDEX IF EXISTS orchestration_v2_projection_context_transfers_source_thread_idx`;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_context_transfers_source_thread_status_idx
    ON orchestration_v2_projection_context_transfers(source_thread_id, status)
  `;
});
