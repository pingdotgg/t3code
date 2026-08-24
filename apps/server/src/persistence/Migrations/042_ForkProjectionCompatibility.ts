import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  const threadColumnNames = new Set(threadColumns.map((column) => column.name));

  // Fork releases used migration id 33 for reasoning_text while upstream used
  // the same id for settled thread state. Reconcile both possible histories.
  if (!threadColumnNames.has("settled_override")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN settled_override TEXT
    `;
  }
  if (!threadColumnNames.has("settled_at")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN settled_at TEXT
    `;
  }

  const messageColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_messages)
  `;
  if (!messageColumns.some((column) => column.name === "reasoning_text")) {
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN reasoning_text TEXT
    `;
  }
});
