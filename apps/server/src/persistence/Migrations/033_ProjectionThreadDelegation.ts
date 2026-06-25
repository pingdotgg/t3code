import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "parent_thread_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN parent_thread_id TEXT
    `;
  }

  if (!columns.some((column) => column.name === "task_label")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN task_label TEXT
    `;
  }

  // Speeds up grouping a lead thread's delegated children in the sidebar.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_parent
    ON projection_threads(parent_thread_id)
  `;
});
