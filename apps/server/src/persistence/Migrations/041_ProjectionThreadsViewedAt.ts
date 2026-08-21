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

  // Upgrading must not make every historical completion appear unread.
  yield* sql`
    UPDATE projection_threads
    SET viewed_at = COALESCE(viewed_at, updated_at, created_at)
    WHERE viewed_at IS NULL
  `;
});
