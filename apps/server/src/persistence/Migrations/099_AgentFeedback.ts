import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE agent_feedback (
    id TEXT PRIMARY KEY, thread_id TEXT, run_id TEXT, created_at TEXT NOT NULL,
    kind TEXT NOT NULL, subject TEXT NOT NULL, expected TEXT NOT NULL,
    actual TEXT NOT NULL, workaround TEXT NOT NULL, source TEXT NOT NULL,
    sent INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`CREATE INDEX agent_feedback_thread_run_idx ON agent_feedback(thread_id, run_id)`;
});
