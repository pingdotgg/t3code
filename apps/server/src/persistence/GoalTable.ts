import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export const ensureGoalTable = Effect.fn("ensureGoalTable")(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_goals (
      thread_id TEXT PRIMARY KEY NOT NULL,
      goal_json TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_goals_status
    ON projection_thread_goals(json_extract(goal_json, '$.status'))
  `;
});
