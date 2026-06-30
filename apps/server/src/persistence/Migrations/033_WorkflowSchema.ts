import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Consolidated workflow schema.
 *
 * Collapses the former migrations 033-055 (all pure DDL — CREATE TABLE /
 * ALTER TABLE ADD COLUMN / CREATE INDEX, no data backfills) into a single
 * migration. ALTER-added columns are folded inline in ascending original
 * migration order, so the resulting schema is byte-for-byte equivalent to the
 * one produced by running the original 23-step chain.
 *
 * This branch (ft/hyperion) has only ever run on a single instance that will
 * be wiped, so renumbering is safe — there is no deployed DB to preserve.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // --- Event store (was 033) ---
  yield* sql`
    CREATE TABLE IF NOT EXISTS workflow_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      ticket_id TEXT NOT NULL,
      stream_version INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )
  `;

  // --- Read-model projections (was 033, with later ALTERs folded in) ---
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_board (
      board_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      workflow_file_path TEXT NOT NULL,
      workflow_version_hash TEXT NOT NULL,
      max_concurrent_tickets INTEGER NOT NULL
    )
  `;

  // projection_ticket base (033) + current_lane_entry_token (034) + queued_at
  // (042) + terminal_at (046) + token_budget (053). description (044) and
  // terminal_at (046) were guarded re-adds in the chain; description already
  // exists in the 033 CREATE, so only the genuinely new columns are appended.
  // attention_kind / attention_reason were added via ALTER in the former 034
  // (BoardNotifications) — folded inline here (TEXT, nullable, matching the
  // ALTER-produced columns).
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_ticket (
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
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_pipeline_run (
      pipeline_run_id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      lane_key TEXT NOT NULL,
      lane_entry_token TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT
    )
  `;

  // projection_step_run base (033) + pre/post_checkpoint_ref (038) +
  // output_json (041) + provider_response_kind (045) + attempt (048) +
  // usage columns (049).
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_step_run (
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
    )
  `;

  // projection_ticket_message (044). edited_at was added via ALTER in the
  // former 035 (TicketMessageEditedAt) — folded inline here (TEXT, nullable,
  // matching the ALTER-produced column).
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_ticket_message (
      message_id TEXT PRIMARY KEY NOT NULL,
      ticket_id TEXT NOT NULL,
      step_run_id TEXT,
      author TEXT NOT NULL,
      body TEXT NOT NULL,
      attachments_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      edited_at TEXT
    )
  `;

  // projection_ticket_dependency (052)
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_ticket_dependency (
      ticket_id TEXT NOT NULL,
      depends_on_ticket_id TEXT NOT NULL,
      PRIMARY KEY (ticket_id, depends_on_ticket_id)
    )
  `;

  // --- Worktree lease (035) ---
  yield* sql`
    CREATE TABLE IF NOT EXISTS worktree_lease (
      worktree_ref TEXT PRIMARY KEY,
      owner_kind TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      fence_token INTEGER NOT NULL,
      acquired_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )
  `;

  // --- Dispatch outbox ---
  // Created (036) then extended via ALTER ADD COLUMN in 047 (options_json) and
  // 051 (project_id, thread_title, runtime_mode). SQLite stores the canonical
  // CREATE SQL with ALTER-appended columns spliced in before the closing paren,
  // which leaves a characteristic ` ,` / ` )` whitespace shape. We reproduce
  // the original CREATE + ALTER sequence verbatim so the stored sqlite_master
  // SQL is byte-for-byte identical to the original 23-step chain.
  yield* sql`
    CREATE TABLE IF NOT EXISTS workflow_dispatch_outbox (
      dispatch_id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      step_run_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      provider_instance TEXT NOT NULL,
      model TEXT NOT NULL,
      instruction TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      started_at TEXT,
      confirmed_at TEXT
    )
  `;
  yield* sql`ALTER TABLE workflow_dispatch_outbox ADD COLUMN options_json TEXT`;
  yield* sql`ALTER TABLE workflow_dispatch_outbox ADD COLUMN project_id TEXT`;
  yield* sql`ALTER TABLE workflow_dispatch_outbox ADD COLUMN thread_title TEXT`;
  yield* sql`ALTER TABLE workflow_dispatch_outbox ADD COLUMN runtime_mode TEXT`;

  // --- Setup run (037) ---
  yield* sql`
    CREATE TABLE IF NOT EXISTS workflow_setup_run (
      setup_run_id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL UNIQUE,
      worktree_ref TEXT NOT NULL,
      status TEXT NOT NULL,
      exit_code INTEGER,
      started_at TEXT NOT NULL,
      finished_at TEXT
    )
  `;

  // --- Project trust (039) ---
  yield* sql`
    CREATE TABLE IF NOT EXISTS workflow_project_trust (
      project_id TEXT PRIMARY KEY,
      trusted_at TEXT NOT NULL
    )
  `;

  // --- Script run (040) ---
  yield* sql`
    CREATE TABLE IF NOT EXISTS workflow_script_run (
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
    )
  `;

  // --- Board version (043) ---
  yield* sql`
    CREATE TABLE IF NOT EXISTS workflow_board_version (
      version_id INTEGER PRIMARY KEY AUTOINCREMENT,
      board_id TEXT NOT NULL,
      version_hash TEXT NOT NULL,
      content_json TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  // --- Board webhook + delivery dedup (054) ---
  yield* sql`
    CREATE TABLE IF NOT EXISTS workflow_board_webhook (
      board_id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL,
      token_prefix TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  // Concurrency-safe best-effort dedupe: the mere PRESENCE of a (board_id,
  // delivery_id) row means "already seen". recordDelivery INSERTs ON CONFLICT
  // DO NOTHING and proceeds only when it actually inserted; releaseDelivery
  // DELETEs the row after a failed ingest so the sender's retry re-ingests.
  yield* sql`
    CREATE TABLE IF NOT EXISTS workflow_webhook_delivery (
      board_id TEXT NOT NULL,
      delivery_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (board_id, delivery_id)
    )
  `;

  // --- Pull request state + observations (055) ---
  yield* sql`
    CREATE TABLE IF NOT EXISTS workflow_pr_state (
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
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS workflow_pr_observation (
      observation_id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      dedup_key TEXT NOT NULL UNIQUE,
      event_name TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      message_body TEXT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `;

  // --- Board notification outbox (was 034) ---
  yield* sql`
    CREATE TABLE IF NOT EXISTS workflow_notification_outbox (
      outbox_id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      board_id TEXT NOT NULL,
      sequence INTEGER NOT NULL UNIQUE,
      status TEXT NOT NULL,
      attention_kind TEXT NULL,
      attention_reason TEXT NULL,
      delivery_state TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `;

  // --- Work sources (was 035) ---
  yield* sql`
    CREATE TABLE IF NOT EXISTS work_source_connection (
      connection_ref TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      display_name TEXT NOT NULL,
      auth_mode TEXT NOT NULL,
      token_secret_name TEXT NOT NULL,
      base_url TEXT NULL,
      auth_email TEXT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS work_source_mapping (
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
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_work_source_mapping_external
    ON work_source_mapping (board_id, source_id, provider, external_id)
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_work_source_mapping_ticket
    ON work_source_mapping (ticket_id)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS work_source_state (
      board_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      cursor_or_etag TEXT NULL,
      last_full_run_at TEXT NULL,
      backoff_until TEXT NULL,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_error TEXT NULL,
      PRIMARY KEY (board_id, source_id)
    )
  `;

  // --- Outbound webhooks ---
  yield* sql`
    CREATE TABLE IF NOT EXISTS workflow_outbound_connection (
      connection_ref TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      display_name TEXT NOT NULL,
      secret_name TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS workflow_outbound_delivery (
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
    )
  `;

  // --- Indexes ---
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_events_stream_version
    ON workflow_events(ticket_id, stream_version)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_workflow_events_ticket_type_time
    ON workflow_events (ticket_id, event_type, occurred_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_ticket_board
    ON projection_ticket(board_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_step_run_ticket
    ON projection_step_run(ticket_id)
  `;
  // WorkflowRecovery scans projection_step_run by status (and step_type) on
  // every server start: recoverConfirmedRunningSteps (WHERE status='running'),
  // recoverRunningMergeSteps / recoverRunningPullRequestSteps
  // (WHERE step_type=? AND status IN (...)). Leading `status` serves the bare
  // status lookup; `step_type` narrows the merge/PR recovery scans.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_step_run_status_type
    ON projection_step_run(status, step_type)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_ticket_lane_admission
    ON projection_ticket(board_id, current_lane_key, current_lane_entry_token)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_ticket_lane_queue
    ON projection_ticket(board_id, current_lane_key, queued_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_ticket_message_ticket
    ON projection_ticket_message(ticket_id, created_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_ticket_terminal_retention
    ON projection_ticket(board_id, current_lane_key, terminal_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_ticket_dependency_depends_on
    ON projection_ticket_dependency(depends_on_ticket_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_dispatch_outbox_pending
    ON workflow_dispatch_outbox(status)
  `;
  // WorkflowRecovery correlates the outbox by step_run_id on every server
  // start: the EXISTS subqueries in recoverConfirmedRunningSteps, isPanelStep's
  // COUNT(*), and settleInterruptedPanel's UPDATE all filter
  // WHERE step_run_id = ?.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_dispatch_outbox_step_run
    ON workflow_dispatch_outbox(step_run_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_workflow_script_run_ticket
    ON workflow_script_run(ticket_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_workflow_script_run_status
    ON workflow_script_run(status)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_workflow_board_version_board
    ON workflow_board_version(board_id, version_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_workflow_board_version_hash
    ON workflow_board_version(board_id, version_hash)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_workflow_pr_state_open
    ON workflow_pr_state (pr_state)
    WHERE pr_state = 'open'
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_workflow_pr_observation_pending
    ON workflow_pr_observation (status, ticket_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_workflow_notification_outbox_pending
    ON workflow_notification_outbox (delivery_state, created_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_workflow_outbound_delivery_due
    ON workflow_outbound_delivery (delivery_state, next_attempt_at)
  `;

  // --- Board self-improvement proposals (E2) ---
  yield* sql`
    CREATE TABLE IF NOT EXISTS workflow_board_proposal (
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
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_workflow_board_proposal_board
    ON workflow_board_proposal (board_id, status, created_at)
  `;

  // --- projection_threads.hidden (050). The table is created by a <=032
  // migration, so this only appends the column. ---
  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0
  `;

  // --- Per-agent session memory (was 034) ---
  // Stores the stable workflow `thread_id` minted for each
  // (ticket_id, lane_key, agent_key) so a continueSession agent step can resume
  // its own provider session across steps/loops.
  yield* sql`
    CREATE TABLE IF NOT EXISTS workflow_agent_session (
      ticket_id    TEXT NOT NULL,
      lane_key     TEXT NOT NULL,
      agent_key    TEXT NOT NULL,
      thread_id    TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      last_used_at TEXT NOT NULL,
      PRIMARY KEY (ticket_id, lane_key, agent_key)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_workflow_agent_session_ticket
    ON workflow_agent_session (ticket_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_workflow_agent_session_thread
    ON workflow_agent_session (thread_id)
  `;
});
