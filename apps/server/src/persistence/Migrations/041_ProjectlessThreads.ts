import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

/** Makes thread ownership optional and stores the concrete execution root. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_threads RENAME TO projection_threads_040`;
  yield* sql`
    CREATE TABLE projection_threads (
      thread_id TEXT PRIMARY KEY, project_id TEXT, workspace_root TEXT,
      title TEXT NOT NULL, model_selection_json TEXT NOT NULL,
      runtime_mode TEXT NOT NULL DEFAULT 'full-access',
      interaction_mode TEXT NOT NULL DEFAULT 'default',
      branch TEXT, worktree_path TEXT, latest_turn_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT,
      settled_override TEXT, settled_at TEXT, snoozed_until TEXT, snoozed_at TEXT,
      pinned_at TEXT, pin_order_key TEXT, title_regeneration_request_id TEXT,
      title_regeneration_started_at TEXT, latest_user_message_at TEXT,
      pending_approval_count INTEGER NOT NULL DEFAULT 0,
      pending_user_input_count INTEGER NOT NULL DEFAULT 0,
      has_actionable_proposed_plan INTEGER NOT NULL DEFAULT 0,
      deleted_at TEXT
    )
  `;
  yield* sql`
    INSERT INTO projection_threads SELECT thread_id, project_id, NULL, title,
      model_selection_json, runtime_mode, interaction_mode, branch, worktree_path,
      latest_turn_id, created_at, updated_at, archived_at, settled_override, settled_at,
      snoozed_until, snoozed_at, pinned_at, pin_order_key, title_regeneration_request_id,
      title_regeneration_started_at, latest_user_message_at, pending_approval_count,
      pending_user_input_count, has_actionable_proposed_plan, deleted_at
    FROM projection_threads_040
  `;
  yield* sql`DROP TABLE projection_threads_040`;
  yield* sql`
    CREATE INDEX idx_projection_threads_project_id
    ON projection_threads(project_id)
  `;
  yield* sql`
    CREATE INDEX idx_projection_threads_project_archived_at
    ON projection_threads(project_id, archived_at)
  `;
  yield* sql`
    CREATE INDEX idx_projection_threads_project_deleted_created
    ON projection_threads(project_id, deleted_at, created_at)
  `;
  yield* sql`
    CREATE INDEX idx_projection_threads_shell_active
    ON projection_threads(deleted_at, archived_at, project_id, created_at, thread_id)
  `;
  yield* sql`
    CREATE INDEX idx_projection_threads_shell_archived
    ON projection_threads(deleted_at, archived_at, project_id, thread_id)
  `;
});
