import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
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
      output TEXT,
      error TEXT,
      started_at TEXT,
      completed_at TEXT,
      PRIMARY KEY (run_id, step_index)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS pipeline_starter_seeds (
      starter_key TEXT PRIMARY KEY,
      pipeline_id TEXT NOT NULL,
      seeded_at TEXT NOT NULL
    )
  `;
});
