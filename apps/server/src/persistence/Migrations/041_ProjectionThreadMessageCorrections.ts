import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_messages)
  `;
  const columnNames = new Set(columns.map((column) => column.name));

  if (!columnNames.has("original_text")) {
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN original_text TEXT
    `;
  }
  if (!columnNames.has("correction_target_message_id")) {
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN correction_target_message_id TEXT
    `;
  }
  if (!columnNames.has("correction_replacement_text")) {
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN correction_replacement_text TEXT
    `;
  }
});
