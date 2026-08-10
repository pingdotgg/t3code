import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * T3-owned agent runs are independent provider sessions backed by nested
 * threads. Prompt/profile bodies live in content-addressed snapshots and are
 * deliberately absent from the hot thread and run projections.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS agent_profile_snapshots (
      revision TEXT PRIMARY KEY,
      document_text TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_agent_runs (
      agent_run_id TEXT PRIMARY KEY,
      parent_run_id TEXT,
      root_run_id TEXT NOT NULL,
      parent_thread_id TEXT NOT NULL,
      child_thread_id TEXT UNIQUE,
      project_id TEXT NOT NULL,
      profile_scope TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      profile_revision TEXT NOT NULL,
      provider_instance_id TEXT NOT NULL,
      model_selection_json TEXT NOT NULL,
      depth INTEGER NOT NULL,
      status TEXT NOT NULL,
      revision INTEGER NOT NULL,
      workspace_mode TEXT NOT NULL,
      detached INTEGER NOT NULL DEFAULT 0,
      budget_json TEXT NOT NULL,
      result_json TEXT,
      usage_json TEXT,
      consumed_tokens INTEGER NOT NULL DEFAULT 0,
      waiting_for_children INTEGER NOT NULL DEFAULT 0,
      integration_target_thread_id TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS agent_run_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_run_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      UNIQUE (agent_run_id, revision)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_agent_runs_parent
    ON projection_agent_runs(parent_thread_id, created_at, agent_run_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_agent_runs_lineage
    ON projection_agent_runs(parent_run_id, status, created_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_agent_runs_root
    ON projection_agent_runs(root_run_id, created_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_agent_run_events_run_revision
    ON agent_run_events(agent_run_id, revision)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_agent_runs_child_thread
    ON projection_agent_runs(child_thread_id)
  `;
});
