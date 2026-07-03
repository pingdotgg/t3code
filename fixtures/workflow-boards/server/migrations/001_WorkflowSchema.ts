import { type PluginMigration } from "@t3tools/plugin-sdk";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const STATEMENTS: ReadonlyArray<string> = [
  `CREATE TABLE p_workflow_boards_events (
     sequence INTEGER PRIMARY KEY AUTOINCREMENT,
     event_id TEXT NOT NULL UNIQUE,
     ticket_id TEXT NOT NULL,
     stream_version INTEGER NOT NULL,
     event_type TEXT NOT NULL,
     occurred_at TEXT NOT NULL,
     payload_json TEXT NOT NULL
   )`,
  `CREATE TABLE p_workflow_boards_projection_board (
     board_id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL,
     name TEXT NOT NULL,
     workflow_file_path TEXT NOT NULL,
     workflow_version_hash TEXT NOT NULL,
     max_concurrent_tickets INTEGER NOT NULL
   )`,
  `CREATE TABLE p_workflow_boards_projection_ticket (
     ticket_id TEXT PRIMARY KEY,
     board_id TEXT NOT NULL,
     title TEXT NOT NULL,
     description TEXT,
     current_lane_key TEXT NOT NULL,
     status TEXT NOT NULL,
     worktree_ref TEXT,
     baseline_ref TEXT,
     external_ref TEXT,
     priority INTEGER,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     current_lane_entry_token TEXT,
     current_lane_entered_at TEXT,
     queued_at TEXT,
     terminal_at TEXT,
     token_budget INTEGER,
     attention_kind TEXT,
     attention_reason TEXT
   )`,
  `CREATE TABLE p_workflow_boards_projection_pipeline_run (
     pipeline_run_id TEXT PRIMARY KEY,
     ticket_id TEXT NOT NULL,
     lane_key TEXT NOT NULL,
     lane_entry_token TEXT NOT NULL,
     status TEXT NOT NULL,
     started_at TEXT NOT NULL,
     finished_at TEXT
   )`,
  `CREATE TABLE p_workflow_boards_projection_step_run (
     step_run_id TEXT PRIMARY KEY,
     pipeline_run_id TEXT NOT NULL,
     ticket_id TEXT NOT NULL,
     step_key TEXT NOT NULL,
     step_type TEXT NOT NULL,
     status TEXT NOT NULL,
     waiting_reason TEXT,
     error TEXT,
     started_at TEXT NOT NULL,
     finished_at TEXT,
     pre_checkpoint_ref TEXT,
     post_checkpoint_ref TEXT,
     output_json TEXT,
     provider_response_kind TEXT,
     attempt INTEGER,
     input_tokens INTEGER,
     cached_input_tokens INTEGER,
     output_tokens INTEGER,
     total_tokens INTEGER,
     retryable INTEGER
   )`,
  `CREATE TABLE p_workflow_boards_projection_ticket_message (
     message_id TEXT PRIMARY KEY NOT NULL,
     ticket_id TEXT NOT NULL,
     step_run_id TEXT,
     author TEXT NOT NULL,
     body TEXT NOT NULL,
     attachments_json TEXT NOT NULL,
     created_at TEXT NOT NULL,
     edited_at TEXT
   )`,
  `CREATE TABLE p_workflow_boards_projection_ticket_dependency (
     ticket_id TEXT NOT NULL,
     depends_on_ticket_id TEXT NOT NULL,
     PRIMARY KEY (ticket_id, depends_on_ticket_id)
   )`,
  `CREATE TABLE p_workflow_boards_worktree_lease (
     worktree_ref TEXT PRIMARY KEY,
     owner_kind TEXT NOT NULL,
     owner_id TEXT NOT NULL,
     fence_token INTEGER NOT NULL,
     acquired_at TEXT NOT NULL,
     expires_at TEXT NOT NULL
   )`,
  `CREATE TABLE p_workflow_boards_dispatch_outbox (
     dispatch_id TEXT PRIMARY KEY,
     ticket_id TEXT NOT NULL,
	     step_run_id TEXT NOT NULL,
	     thread_id TEXT NOT NULL,
	     turn_id TEXT,
	     message_id TEXT,
	     provider_instance TEXT NOT NULL,
     model TEXT NOT NULL,
     instruction TEXT NOT NULL,
     worktree_path TEXT NOT NULL,
     status TEXT NOT NULL,
     created_at TEXT NOT NULL,
     started_at TEXT,
     confirmed_at TEXT,
     options_json TEXT,
     project_id TEXT,
     thread_title TEXT,
     runtime_mode TEXT
   )`,
  `CREATE TABLE p_workflow_boards_setup_run (
     setup_run_id TEXT PRIMARY KEY,
     ticket_id TEXT NOT NULL UNIQUE,
     worktree_ref TEXT NOT NULL,
     status TEXT NOT NULL,
     exit_code INTEGER,
     started_at TEXT NOT NULL,
     finished_at TEXT
   )`,
  `CREATE TABLE p_workflow_boards_project_trust (
     project_id TEXT PRIMARY KEY,
     trusted_at TEXT NOT NULL
   )`,
  `CREATE TABLE p_workflow_boards_script_run (
     script_run_id TEXT PRIMARY KEY,
     step_run_id TEXT NOT NULL UNIQUE,
     ticket_id TEXT NOT NULL,
     script_thread_id TEXT NOT NULL,
     terminal_id TEXT NOT NULL,
     status TEXT NOT NULL,
     exit_code INTEGER,
     signal INTEGER,
     started_at TEXT NOT NULL,
     finished_at TEXT
   )`,
  `CREATE TABLE p_workflow_boards_board_version (
     version_id INTEGER PRIMARY KEY AUTOINCREMENT,
     board_id TEXT NOT NULL,
     version_hash TEXT NOT NULL,
     content_json TEXT NOT NULL,
     source TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,
  `CREATE TABLE p_workflow_boards_board_webhook (
     board_id TEXT PRIMARY KEY,
     token_hash TEXT NOT NULL,
     token_prefix TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,
  `CREATE TABLE p_workflow_boards_webhook_delivery (
     board_id TEXT NOT NULL,
     delivery_id TEXT NOT NULL,
     created_at TEXT NOT NULL,
     PRIMARY KEY (board_id, delivery_id)
   )`,
  `CREATE TABLE p_workflow_boards_pr_state (
     ticket_id TEXT PRIMARY KEY,
     pr_number INTEGER NOT NULL,
     pr_url TEXT NOT NULL,
     branch TEXT NOT NULL,
     remote_name TEXT NOT NULL,
     repo TEXT NOT NULL,
     pr_state TEXT NOT NULL DEFAULT 'open',
     last_head_sha TEXT NULL,
     last_ci_state TEXT NULL,
     last_review_decision TEXT NULL,
     last_comment_cursor TEXT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE TABLE p_workflow_boards_pr_observation (
     observation_id TEXT PRIMARY KEY,
     ticket_id TEXT NOT NULL,
     dedup_key TEXT NOT NULL UNIQUE,
     event_name TEXT NOT NULL,
     payload_json TEXT NOT NULL,
     message_body TEXT NULL,
     status TEXT NOT NULL DEFAULT 'pending',
     attempt_count INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL
   )`,
  `CREATE TABLE p_workflow_boards_work_source_connection (
     connection_ref TEXT PRIMARY KEY,
     provider TEXT NOT NULL,
     display_name TEXT NOT NULL,
     auth_mode TEXT NOT NULL,
     token_secret_name TEXT NOT NULL,
     base_url TEXT NULL,
     auth_email TEXT NULL,
     created_at TEXT NOT NULL
   )`,
  `CREATE TABLE p_workflow_boards_work_source_mapping (
     mapping_id TEXT PRIMARY KEY,
     board_id TEXT NOT NULL,
     source_id TEXT NOT NULL,
     provider TEXT NOT NULL,
     external_id TEXT NOT NULL,
     ticket_id TEXT NOT NULL,
     provider_version TEXT NULL,
     content_hash TEXT NOT NULL,
     lifecycle TEXT NOT NULL,
     sync_status TEXT NOT NULL DEFAULT 'active',
     source_metadata_json TEXT NULL,
     created_at TEXT NOT NULL,
     last_synced_at TEXT NOT NULL
   )`,
  `CREATE TABLE p_workflow_boards_work_source_state (
     board_id TEXT NOT NULL,
     source_id TEXT NOT NULL,
     cursor_or_etag TEXT NULL,
     last_full_run_at TEXT NULL,
     backoff_until TEXT NULL,
     consecutive_failures INTEGER NOT NULL DEFAULT 0,
     last_error TEXT NULL,
     PRIMARY KEY (board_id, source_id)
   )`,
  `CREATE TABLE p_workflow_boards_outbound_connection (
     connection_ref TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     display_name TEXT NOT NULL,
     secret_name TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,
  `CREATE TABLE p_workflow_boards_outbound_delivery (
     delivery_id TEXT PRIMARY KEY,
     board_id TEXT NOT NULL,
     ticket_id TEXT NOT NULL,
     rule_id TEXT NOT NULL,
     event_sequence INTEGER NOT NULL,
     connection_ref TEXT NOT NULL,
     formatter TEXT NOT NULL,
     context_json TEXT NOT NULL,
     delivery_state TEXT NOT NULL DEFAULT 'pending',
     attempt_count INTEGER NOT NULL DEFAULT 0,
     next_attempt_at TEXT NULL,
     created_at TEXT NOT NULL,
     last_error TEXT NULL,
     UNIQUE (event_sequence, rule_id)
   )`,
  `CREATE TABLE p_workflow_boards_board_proposal (
     proposal_id          TEXT PRIMARY KEY,
     board_id             TEXT NOT NULL,
     base_version_hash    TEXT NOT NULL,
     base_def_json        TEXT NOT NULL,
     agent_json           TEXT NOT NULL,
     proposed_def_json    TEXT NOT NULL,
     rationale            TEXT NOT NULL,
     validation_json      TEXT NOT NULL,
     status               TEXT NOT NULL DEFAULT 'pending',
     applied_version_hash TEXT NULL,
     created_at           TEXT NOT NULL,
     resolved_at          TEXT NULL
   )`,
  `CREATE TABLE p_workflow_boards_agent_session (
     ticket_id    TEXT NOT NULL,
     lane_key     TEXT NOT NULL,
     agent_key    TEXT NOT NULL,
     thread_id    TEXT NOT NULL,
     created_at   TEXT NOT NULL,
     last_used_at TEXT NOT NULL,
     PRIMARY KEY (ticket_id, lane_key, agent_key)
   )`,
  `CREATE UNIQUE INDEX p_workflow_boards_idx_workflow_events_stream_version
   ON p_workflow_boards_events(ticket_id, stream_version)`,
  `CREATE INDEX p_workflow_boards_idx_workflow_events_ticket_type_time
   ON p_workflow_boards_events (ticket_id, event_type, occurred_at)`,
  `CREATE INDEX p_workflow_boards_idx_projection_ticket_board
   ON p_workflow_boards_projection_ticket(board_id)`,
  `CREATE INDEX p_workflow_boards_idx_projection_step_run_ticket
   ON p_workflow_boards_projection_step_run(ticket_id)`,
  `CREATE INDEX p_workflow_boards_idx_projection_step_run_status_type
   ON p_workflow_boards_projection_step_run(status, step_type)`,
  `CREATE INDEX p_workflow_boards_idx_projection_ticket_lane_admission
   ON p_workflow_boards_projection_ticket(board_id, current_lane_key, current_lane_entry_token)`,
  `CREATE INDEX p_workflow_boards_idx_projection_ticket_lane_queue
   ON p_workflow_boards_projection_ticket(board_id, current_lane_key, queued_at)`,
  `CREATE INDEX p_workflow_boards_idx_projection_ticket_message_ticket
   ON p_workflow_boards_projection_ticket_message(ticket_id, created_at)`,
  `CREATE INDEX p_workflow_boards_idx_projection_ticket_terminal_retention
   ON p_workflow_boards_projection_ticket(board_id, current_lane_key, terminal_at)`,
  `CREATE INDEX p_workflow_boards_idx_projection_ticket_dependency_depends_on
   ON p_workflow_boards_projection_ticket_dependency(depends_on_ticket_id)`,
  `CREATE INDEX p_workflow_boards_idx_dispatch_outbox_pending
   ON p_workflow_boards_dispatch_outbox(status)`,
  `CREATE INDEX p_workflow_boards_idx_dispatch_outbox_step_run
   ON p_workflow_boards_dispatch_outbox(step_run_id)`,
  `CREATE INDEX p_workflow_boards_idx_workflow_script_run_ticket
   ON p_workflow_boards_script_run(ticket_id)`,
  `CREATE INDEX p_workflow_boards_idx_workflow_script_run_status
   ON p_workflow_boards_script_run(status)`,
  `CREATE INDEX p_workflow_boards_idx_workflow_board_version_board
   ON p_workflow_boards_board_version(board_id, version_id)`,
  `CREATE INDEX p_workflow_boards_idx_workflow_board_version_hash
   ON p_workflow_boards_board_version(board_id, version_hash)`,
  `CREATE INDEX p_workflow_boards_idx_workflow_pr_state_open
   ON p_workflow_boards_pr_state (pr_state)
   WHERE pr_state = 'open'`,
  `CREATE INDEX p_workflow_boards_idx_workflow_pr_observation_pending
   ON p_workflow_boards_pr_observation (status, ticket_id)`,
  `CREATE INDEX p_workflow_boards_idx_workflow_outbound_delivery_due
   ON p_workflow_boards_outbound_delivery (delivery_state, next_attempt_at)`,
  `CREATE UNIQUE INDEX p_workflow_boards_idx_work_source_mapping_external
   ON p_workflow_boards_work_source_mapping (board_id, source_id, provider, external_id)`,
  `CREATE UNIQUE INDEX p_workflow_boards_idx_work_source_mapping_ticket
   ON p_workflow_boards_work_source_mapping (ticket_id)`,
  `CREATE INDEX p_workflow_boards_idx_workflow_board_proposal_board
   ON p_workflow_boards_board_proposal (board_id, status, created_at)`,
  `CREATE INDEX p_workflow_boards_idx_workflow_agent_session_ticket
   ON p_workflow_boards_agent_session (ticket_id)`,
  `CREATE INDEX p_workflow_boards_idx_workflow_agent_session_thread
   ON p_workflow_boards_agent_session (thread_id)`,
];

const toPluginError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

export const migration001: PluginMigration = {
  version: 1,
  name: "workflow_schema",
  up: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const statement of STATEMENTS) {
      yield* sql.unsafe(statement).unprepared;
    }
  }).pipe(Effect.mapError(toPluginError)),
};
