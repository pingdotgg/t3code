import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "snoozed_until")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN snoozed_until TEXT
    `;
  }

  if (!columns.some((column) => column.name === "snoozed_at")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN snoozed_at TEXT
    `;
  }
});
