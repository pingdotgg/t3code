import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(scheduled_tasks)
  `;

  if (!columns.some((column) => column.name === "enabled_seq")) {
    yield* sql`
      ALTER TABLE scheduled_tasks
      ADD COLUMN enabled_seq INTEGER
    `;
  }
});
