import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "last_visited_at")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN last_visited_at TEXT
    `;
  }

  // Threads that predate visited tracking stay read after the upgrade
  // instead of lighting up every historical completion as unread.
  yield* sql`
    UPDATE projection_threads
    SET last_visited_at = COALESCE(updated_at, created_at)
    WHERE last_visited_at IS NULL
  `;
});
