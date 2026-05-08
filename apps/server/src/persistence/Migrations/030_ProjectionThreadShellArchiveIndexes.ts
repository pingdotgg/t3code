import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_shell_active
    ON projection_threads(deleted_at, archived_at, project_id, created_at, thread_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_shell_archived
    ON projection_threads(deleted_at, archived_at, project_id, thread_id)
  `;
});
