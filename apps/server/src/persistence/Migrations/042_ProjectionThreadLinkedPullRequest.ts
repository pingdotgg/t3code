import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "linked_pull_request_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN linked_pull_request_json TEXT
    `;
  }
});
