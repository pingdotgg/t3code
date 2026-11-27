import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Keyed by folder: subagents, forks and reused worktrees share one path across threads.
  yield* sql`
    CREATE TABLE IF NOT EXISTS task_folders (
      root TEXT PRIMARY KEY,
      real_root TEXT NOT NULL,
      project_id TEXT NOT NULL,
      project_root TEXT NOT NULL,
      anchor TEXT NOT NULL,
      project_path TEXT NOT NULL,
      project_is_worktree INTEGER NOT NULL,
      repositories_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_task_folders_real_root ON task_folders (real_root)`;
});
