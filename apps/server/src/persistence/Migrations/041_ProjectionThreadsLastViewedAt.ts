import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "last_viewed_at")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN last_viewed_at TEXT
    `;

    // Existing threads start read, while wakes after the upgrade remain visible.
    yield* sql`
      UPDATE projection_threads
      SET last_viewed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    `;
  }
});
