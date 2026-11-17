import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const created = yield* sql`
    CREATE VIRTUAL TABLE orchestration_v2_tool_search USING fts5(
      text,
      content = '',
      contentless_delete = 1,
      tokenize = 'unicode61'
    )
  `.pipe(
    Effect.as(true),
    Effect.catchIf(
      (cause) =>
        Predicate.hasProperty(cause.reason.cause, "errcode") && cause.reason.cause.errcode === 1,
      (cause) =>
        Effect.logWarning("Tool output search index unavailable.", cause).pipe(Effect.as(false)),
    ),
  );
  if (!created) return;
  yield* sql`
    CREATE TABLE orchestration_v2_tool_search_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      cursor INTEGER NOT NULL,
      backfill_end INTEGER NOT NULL
    )
  `;
  yield* sql`
    INSERT INTO orchestration_v2_tool_search_state (id, cursor, backfill_end)
    SELECT 1, 0, coalesce(max(rowid), 0) FROM orchestration_v2_projection_turn_items
  `;
});
