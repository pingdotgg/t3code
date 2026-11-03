import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Creates the multi-repo project schema (pingdotgg/t3code#26254 ships it as numbered migrations).
 * It runs after the numbered migrations because the migrator skips every id up to the highest
 * recorded one, so a fork-only id would collide with the next upstream migration. Names match the
 * upstream migration so it finds the schema in place when it lands. Idempotent on every start.
 */
export const ensureMultiRepoSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;
  if (!columns.some((column) => column.name === "tracked_folders_json")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN tracked_folders_json TEXT NOT NULL DEFAULT '[]'
    `;
  }

  yield* sql`
    CREATE TABLE IF NOT EXISTS task_folders (
      root TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      home_worktree_path TEXT NOT NULL,
      repositories_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_task_folders_project_id ON task_folders (project_id)
  `;
});
