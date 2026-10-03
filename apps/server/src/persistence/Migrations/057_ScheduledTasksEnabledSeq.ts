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

  // Enablements that predate the column count as committed now: an archive
  // already in the event log must not read as newer than them, or the startup
  // sweep would pause tasks on threads that were archived and later unarchived.
  // A thread that is still archived is paused by the sweep regardless.
  yield* sql`
    UPDATE scheduled_tasks
    SET enabled_seq = (SELECT COALESCE(MAX(sequence), 0) FROM orchestration_events)
    WHERE enabled = 1 AND enabled_seq IS NULL
  `;
});
