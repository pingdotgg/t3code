import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_messages)
  `;

  if (!columns.some((column) => column.name === "message_phase")) {
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN message_phase TEXT
      CHECK (message_phase IN ('commentary', 'final_answer') OR message_phase IS NULL)
    `;
  }
});
