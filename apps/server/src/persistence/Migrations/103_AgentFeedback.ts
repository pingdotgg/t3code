import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE agent_feedback (
    id TEXT PRIMARY KEY, thread_id TEXT, run_id TEXT, created_at TEXT NOT NULL,
    kind TEXT NOT NULL, subject TEXT NOT NULL, expected TEXT NOT NULL,
    actual TEXT NOT NULL, workaround TEXT NOT NULL,
    user_requested INTEGER NOT NULL DEFAULT 0, trace TEXT, source TEXT NOT NULL,
    sent INTEGER NOT NULL DEFAULT 0
  )`;
  // The per-turn limit counts by turn and kind; reports outside a turn are few.
  yield* sql`CREATE INDEX agent_feedback_run_idx ON agent_feedback(run_id, user_requested)`;
});
