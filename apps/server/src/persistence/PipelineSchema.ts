import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Creates the Pipelines tables. It runs after the numbered migrations instead of taking an id in
 * their ladder: the migrator skips every id up to the highest recorded one, so a fork-only id would
 * collide with the next upstream migration. Every statement is idempotent, so it runs on each start.
 */
export const ensurePipelineSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS pipelines (
      pipeline_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      steps_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS pipeline_runs (
      run_id TEXT PRIMARY KEY,
      pipeline_id TEXT,
      definition_json TEXT NOT NULL,
      project_id TEXT NOT NULL,
      parent_thread_id TEXT NOT NULL UNIQUE,
      input TEXT NOT NULL,
      workspace_strategy_json TEXT NOT NULL,
      status TEXT NOT NULL,
      pause_reason TEXT,
      error TEXT,
      current_step_index INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      creation_source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_pipeline_runs_live
    ON pipeline_runs(status)
    WHERE status IN ('running', 'paused')
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS pipeline_run_steps (
      run_id TEXT NOT NULL,
      step_index INTEGER NOT NULL,
      step_id TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      child_thread_id TEXT,
      pause_before INTEGER NOT NULL,
      prompt TEXT,
      workspace_strategy_json TEXT,
      start_checkpoint_json TEXT,
      output TEXT,
      error TEXT,
      started_at TEXT,
      completed_at TEXT,
      PRIMARY KEY (run_id, step_index)
    )
  `;

  // Added after the table shipped: SQLite has no ADD COLUMN IF NOT EXISTS.
  const stepColumns = yield* sql<{ readonly name: string }>`PRAGMA table_info(pipeline_run_steps)`;
  if (!stepColumns.some((column) => column.name === "handed_off")) {
    yield* sql`ALTER TABLE pipeline_run_steps ADD COLUMN handed_off INTEGER NOT NULL DEFAULT 0`;
  }

  if (!stepColumns.some((column) => column.name === "revising")) {
    yield* sql`ALTER TABLE pipeline_run_steps ADD COLUMN revising INTEGER NOT NULL DEFAULT 0`;
  }
  const runColumns = yield* sql<{ readonly name: string }>`PRAGMA table_info(pipeline_runs)`;
  if (!runColumns.some((column) => column.name === "revisions_json")) {
    yield* sql`ALTER TABLE pipeline_runs ADD COLUMN revisions_json TEXT NOT NULL DEFAULT '[]'`;
  }

  yield* sql`
    CREATE TABLE IF NOT EXISTS pipeline_starter_seeds (
      starter_key TEXT PRIMARY KEY,
      pipeline_id TEXT NOT NULL,
      seeded_at TEXT NOT NULL
    )
  `;
});
