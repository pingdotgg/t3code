import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS git_activity_log (
      id INTEGER PRIMARY KEY,
      occurred_at TEXT NOT NULL,
      operation TEXT NOT NULL,
      args_json TEXT NOT NULL,
      exit_code INTEGER,
      duration_ms INTEGER NOT NULL,
      cwd TEXT NOT NULL,
      thread_id TEXT,
      pull_requests_json TEXT NOT NULL DEFAULT '[]',
      is_mutating INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_git_activity_log_occurred_at
    ON git_activity_log(occurred_at DESC, id DESC)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_git_activity_log_thread
    ON git_activity_log(thread_id, id DESC)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_git_activity_log_mutating
    ON git_activity_log(is_mutating, id DESC)
  `;
});
