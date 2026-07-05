import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (columns.some((column) => column.name === "linked_linear_issue_json")) {
    return;
  }

  // Stores the JSON-encoded LinearIssueLink (or the string "null" when a thread
  // is not linked to a Linear issue). Existing rows default to "null".
  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN linked_linear_issue_json TEXT NOT NULL DEFAULT 'null'
  `;
});
