import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The fork previously shipped snoozed_through_turn_id as migrations 53 and
  // 54, colliding with later upstream migrations. Repair every upgrade path.
  yield* sql`
    CREATE TABLE IF NOT EXISTS pull_request_files_viewed (
      provider TEXT NOT NULL,
      host TEXT NOT NULL,
      repository TEXT NOT NULL,
      number INTEGER NOT NULL,
      viewer TEXT NOT NULL,
      path TEXT NOT NULL,
      revision TEXT,
      viewed_at TEXT NOT NULL,
      PRIMARY KEY (provider, host, repository, number, viewer, path)
    ) WITHOUT ROWID
  `;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "auto_settle_disabled_at")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN auto_settle_disabled_at TEXT
    `;
  }

  if (!columns.some((column) => column.name === "snoozed_through_turn_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN snoozed_through_turn_id TEXT
    `;
  }
});
