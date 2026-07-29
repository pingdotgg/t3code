import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const messageColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_messages)
  `;
  if (!messageColumns.some((column) => column.name === "origin_json")) {
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN origin_json TEXT
    `;
  }

  const queuedTurnColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_queued_turns)
  `;
  if (!queuedTurnColumns.some((column) => column.name === "origin_json")) {
    yield* sql`
      ALTER TABLE projection_queued_turns
      ADD COLUMN origin_json TEXT
    `;
  }
});
