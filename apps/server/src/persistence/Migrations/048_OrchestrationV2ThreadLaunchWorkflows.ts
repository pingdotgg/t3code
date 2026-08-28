import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_v2_thread_launch_workflows (
      command_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      worktree_path TEXT,
      branch TEXT,
      setup_committed INTEGER NOT NULL DEFAULT 0,
      thread_committed INTEGER NOT NULL DEFAULT 0,
      message_committed INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
