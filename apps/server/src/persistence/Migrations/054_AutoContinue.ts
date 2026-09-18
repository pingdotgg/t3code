import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!threadColumns.some((column) => column.name === "auto_continue_at")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN auto_continue_at TEXT
    `;
  }

  const sessionColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_sessions)
  `;
  if (!sessionColumns.some((column) => column.name === "last_error_limit_resets_at")) {
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN last_error_limit_resets_at TEXT
    `;
  }
});
