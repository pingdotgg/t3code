import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS worktree_cleanup_jobs (
      thread_id TEXT PRIMARY KEY,
      cwd TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'cancelled')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_worktree_cleanup_jobs_pending_path
    ON worktree_cleanup_jobs(worktree_path)
    WHERE status = 'pending'
  `;
});
