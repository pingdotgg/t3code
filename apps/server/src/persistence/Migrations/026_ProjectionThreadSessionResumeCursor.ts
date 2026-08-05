import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_sessions)
  `;

  if (columns.some((column) => column.name === "resume_cursor_json")) {
    return;
  }

  yield* sql`
    ALTER TABLE projection_thread_sessions
    ADD COLUMN resume_cursor_json TEXT
  `;
});
