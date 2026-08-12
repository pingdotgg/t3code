import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "operator_parent_thread_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN operator_parent_thread_id TEXT
    `;
  }
  if (!columns.some((column) => column.name === "operator_batch_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN operator_batch_id TEXT
    `;
  }
  if (!columns.some((column) => column.name === "operator_workspace_path")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN operator_workspace_path TEXT
    `;
  }
  if (!columns.some((column) => column.name === "operator_workspace_branch")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN operator_workspace_branch TEXT
    `;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_operator_parent
    ON projection_threads(operator_parent_thread_id, created_at, thread_id)
  `;
});
