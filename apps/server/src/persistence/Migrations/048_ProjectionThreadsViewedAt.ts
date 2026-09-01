import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "viewed_at")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN viewed_at TEXT
    `;
  }

  // Threads that predate server-owned read state stay read after the
  // upgrade instead of lighting up every historical completion as unread.
  yield* sql`
    UPDATE projection_threads
    SET viewed_at = COALESCE(updated_at, created_at)
    WHERE viewed_at IS NULL
  `;
});
