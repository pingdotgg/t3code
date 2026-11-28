import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Opening a thread's history looks up its few superseded attempts. Without this index that
  // reads every attempt row of the thread, which is slow on a long thread with a cold cache.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_run_attempts_superseded_idx
    ON orchestration_v2_projection_run_attempts(thread_id, run_id, root_node_id)
    WHERE status = 'superseded'
  `;
});
