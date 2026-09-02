import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  const sessionColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_sessions)
  `;

  if (!threadColumns.some((column) => column.name === "usage_limit_resume_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN usage_limit_resume_json TEXT
    `;
  }
  if (!sessionColumns.some((column) => column.name === "last_error_class")) {
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN last_error_class TEXT
    `;
  }
  if (!sessionColumns.some((column) => column.name === "retry_at")) {
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN retry_at TEXT
    `;
  }
});
