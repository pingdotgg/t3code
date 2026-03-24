import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // SQLite doesn't support ALTER TABLE to change NOT NULL to nullable,
  // so we need to recreate the table
  yield* sql`
    ALTER TABLE projection_threads RENAME TO projection_threads_old
  `;

  yield* sql`
    CREATE TABLE projection_threads (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      model TEXT,
      runtime_mode TEXT NOT NULL,
      interaction_mode TEXT NOT NULL,
      branch TEXT,
      worktree_path TEXT,
      latest_turn_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `;

  yield* sql`
    INSERT INTO projection_threads (
      thread_id,
      project_id,
      title,
      model,
      runtime_mode,
      interaction_mode,
      branch,
      worktree_path,
      latest_turn_id,
      created_at,
      updated_at,
      deleted_at
    )
    SELECT
      thread_id,
      project_id,
      title,
      model,
      runtime_mode,
      interaction_mode,
      branch,
      worktree_path,
      latest_turn_id,
      created_at,
      updated_at,
      deleted_at
    FROM projection_threads_old
  `;

  yield* sql`
    DROP TABLE projection_threads_old
  `;
});