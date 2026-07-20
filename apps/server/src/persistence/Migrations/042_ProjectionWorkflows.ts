import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_workflow_runs (
      run_id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      parent_thread_id TEXT NOT NULL,
      status TEXT NOT NULL,
      definition_json TEXT NOT NULL,
      final_artifact_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_workflow_nodes (
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      status TEXT NOT NULL,
      worker_thread_id TEXT,
      input_artifact_id TEXT,
      result_artifact_id TEXT,
      started_at TEXT,
      completed_at TEXT,
      PRIMARY KEY (run_id, node_id)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_workflow_artifacts (
      artifact_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      node_id TEXT,
      producer_thread_id TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_workflow_runs_status_created
    ON projection_workflow_runs(status, created_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_workflow_nodes_worker_thread
    ON projection_workflow_nodes(worker_thread_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_workflow_artifacts_run
    ON projection_workflow_artifacts(run_id, created_at)
  `;
});
