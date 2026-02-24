import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_projects (
      project_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      workspace_root TEXT NOT NULL,
      default_model TEXT,
      scripts_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_threads (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      model TEXT NOT NULL,
      branch TEXT,
      worktree_path TEXT,
      latest_turn_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_messages (
      message_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      is_streaming INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_activities (
      activity_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      tone TEXT NOT NULL,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_sessions (
      thread_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      provider_name TEXT,
      provider_session_id TEXT,
      provider_thread_id TEXT,
      active_turn_id TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_turns (
      turn_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      turn_count INTEGER NOT NULL,
      status TEXT NOT NULL,
      user_message_id TEXT,
      assistant_message_id TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE (thread_id, turn_count)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_checkpoints (
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      checkpoint_turn_count INTEGER NOT NULL,
      checkpoint_ref TEXT NOT NULL,
      status TEXT NOT NULL,
      files_json TEXT NOT NULL,
      assistant_message_id TEXT,
      completed_at TEXT NOT NULL,
      UNIQUE (thread_id, checkpoint_turn_count)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_pending_approvals (
      request_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      status TEXT NOT NULL,
      decision TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_state (
      projector TEXT PRIMARY KEY,
      last_applied_sequence INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_projects_updated_at
    ON projection_projects(updated_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_project_id
    ON projection_threads(project_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_messages_thread_created
    ON projection_thread_messages(thread_id, created_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_thread_created
    ON projection_thread_activities(thread_id, created_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_sessions_provider_session
    ON projection_thread_sessions(provider_session_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_turns_thread_turn_count
    ON projection_thread_turns(thread_id, turn_count)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_checkpoints_thread_completed
    ON projection_checkpoints(thread_id, completed_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_pending_approvals_thread_status
    ON projection_pending_approvals(thread_id, status)
  `;
});
