import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Opening a thread reads its live attempts, provider turns and checkpoints and the window's
  // own by key. With only the thread index, each read fetched every such row of the thread.
  // Keep the partial predicates identical to ProjectionStore's thread-window reads.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_run_attempts_active_idx
    ON orchestration_v2_projection_run_attempts(thread_id)
    WHERE status IN ('pending', 'starting', 'running', 'waiting')
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_provider_turns_active_idx
    ON orchestration_v2_projection_provider_turns(thread_id)
    WHERE status IN ('starting', 'running', 'waiting')
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_provider_turns_node_idx
    ON orchestration_v2_projection_provider_turns(node_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_checkpoints_thread_status_idx
    ON orchestration_v2_projection_checkpoints(thread_id, status, app_run_ordinal)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_checkpoints_root_idx
    ON orchestration_v2_projection_checkpoints(thread_id)
    WHERE run_id IS NULL AND ordinal_within_scope = 0
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_checkpoints_run_idx
    ON orchestration_v2_projection_checkpoints(run_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_checkpoints_node_idx
    ON orchestration_v2_projection_checkpoints(node_id)
  `;
});
