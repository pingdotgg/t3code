import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const hasColumn = (columns: ReadonlyArray<{ readonly name: string }>, name: string) =>
  columns.some((column) => column.name === name);

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;

  if (!hasColumn(columns, "review_snapshot_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN review_snapshot_json TEXT NOT NULL DEFAULT 'null'
    `;
  }
  if (!hasColumn(columns, "review_result_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN review_result_json TEXT NOT NULL DEFAULT 'null'
    `;
  }
});
