import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_pr_monitor_feedback_state_pending
    ON pull_request_monitor_feedback_state(updated_at DESC, monitor_id DESC)
    WHERE pending_revision_ids_json <> '[]'
  `;
});
