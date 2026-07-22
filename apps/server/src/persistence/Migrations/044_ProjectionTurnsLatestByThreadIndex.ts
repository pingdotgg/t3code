import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_turns_latest_by_thread
    ON projection_turns(thread_id, requested_at DESC, turn_id DESC)
    WHERE turn_id IS NOT NULL
  `;
});
