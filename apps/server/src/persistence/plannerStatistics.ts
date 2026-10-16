import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * sqlite_stat1 rows for every index, from a full ANALYZE of a 48 GB database
 * with 14M events. Without statistics the planner guesses at index
 * selectivity, and large databases have full-scanned on reads that had a
 * usable index. Collecting them with ANALYZE reads every page of the large
 * tables, which took minutes on that database before the server could answer.
 * The planner mostly needs each index's relative selectivity, which barely
 * changes with size, so fixed rows give a new database and a 50 GB one the
 * same plans at no cost.
 *
 * Indexes on tables that were empty there have estimated rows. A migration
 * that adds an index adds its row here, measured on a large database or
 * estimated from a similar index.
 */
export const PLANNER_STATISTICS: Readonly<Record<string, string>> = {
  idx_auth_pairing_links_active: "556 556 1 1",
  idx_auth_sessions_active: "548 50 1 1",
  idx_checkpoint_diff_blobs_thread_to_turn: "1000 10 1",
  idx_orch_command_receipts_aggregate: "301300 150650 646",
  idx_orch_command_receipts_sequence: "301300 1",
  idx_orch_events_command_id: "13869561 47",
  idx_orch_events_correlation_id: "13869561 47",
  idx_orch_events_stream_sequence: "13869561 6934781 20826 1",
  idx_orch_events_stream_version: "13869561 6934781 20826 1",
  idx_orchestration_events_agent_stream_sequence: "13595079 20568 1",
  idx_orchestration_events_application_high_water: "13595089 1",
  idx_orchestration_events_application_sequence: "13869561 6934781 1",
  idx_projection_pending_approvals_thread_status: "1000 10 5",
  idx_projection_projects_updated_at: "5 1",
  idx_projection_projects_workspace_root_deleted_at: "5 1 1",
  idx_projection_thread_activities_thread_created: "112980 1712 2",
  idx_projection_thread_activities_thread_sequence_created_id: "112980 1712 1712 2 1",
  idx_projection_thread_messages_thread_created_id: "23713 200 1 1",
  idx_projection_thread_proposed_plans_thread_created: "1000 10 1",
  idx_projection_thread_pull_requests_pr: "93 93 31 1",
  idx_projection_thread_sessions_instance: "66 22",
  idx_projection_thread_sessions_provider_session: "66 66",
  idx_projection_threads_project_archived_at: "119 60 60",
  idx_projection_threads_project_deleted_created: "119 60 14 1",
  idx_projection_threads_shell_active: "119 15 15 14 1 1",
  idx_projection_threads_shell_archived: "119 15 15 14 1",
  idx_projection_turns_thread_checkpoint_completed: "275 5 1 1",
  idx_projection_turns_thread_keyset: "275 5 1 1",
  idx_provider_session_runtime_instance: "118 30",
  idx_provider_session_runtime_provider: "118 40",
  idx_provider_session_runtime_status: "118 118",
  idx_scheduled_task_webhook_deliveries_task: "1000 100 1",
  idx_scheduled_task_webhook_relay_deliveries_seen: "1000 1",
  idx_scheduled_tasks_due: "2 2 1",
  idx_scheduled_tasks_project: "2 2 1",
  orchestration_events_v2_created_threads_idx: "670 1",
  orchestration_v2_command_receipts_thread_sequence_idx: "1000 10 1",
  orchestration_v2_effect_outbox_claim_idx: "4764 2382 1 1 1",
  orchestration_v2_effect_outbox_command_idx: "4764 1 1",
  orchestration_v2_effect_outbox_thread_status_idx: "4764 21 21 7",
  orchestration_v2_events_command_idx: "1000 5 1",
  orchestration_v2_events_instance_sequence_idx: "1000 200 1",
  orchestration_v2_events_node_sequence_idx: "1000 5 1",
  orchestration_v2_events_raw_event_idx: "1000 1",
  orchestration_v2_events_run_sequence_idx: "1000 50 1",
  orchestration_v2_events_thread_sequence_idx: "1000 100 1",
  orchestration_v2_events_thread_type_sequence_idx: "1000 100 10 1",
  orchestration_v2_legacy_imports_pending_transcript_idx: "119 1 1 1",
  orchestration_v2_projection_checkpoint_scopes_parent_idx: "289 289",
  orchestration_v2_projection_checkpoint_scopes_thread_idx: "289 1",
  orchestration_v2_projection_checkpoints_parent_idx: "2920 2",
  orchestration_v2_projection_checkpoints_scope_ordinal_idx: "2920 11 1",
  orchestration_v2_projection_checkpoints_thread_idx: "2920 11",
  orchestration_v2_projection_context_handoffs_target_run_idx: "101 2",
  orchestration_v2_projection_context_handoffs_thread_idx: "101 4",
  orchestration_v2_projection_context_transfers_source_thread_idx: "188 2",
  orchestration_v2_projection_context_transfers_target_run_idx: "188 2",
  orchestration_v2_projection_context_transfers_target_thread_idx: "188 2 2",
  orchestration_v2_projection_messages_latest_user_idx: "4301 8 1 1",
  orchestration_v2_projection_messages_node_idx: "35222 2",
  orchestration_v2_projection_messages_run_idx: "35222 13",
  orchestration_v2_projection_messages_thread_created_idx: "35222 54 1 1",
  orchestration_v2_projection_nodes_live_idx: "102 3",
  orchestration_v2_projection_nodes_parent_idx: "188231 64",
  orchestration_v2_projection_nodes_provider_turn_idx: "188231 67",
  orchestration_v2_projection_nodes_thread_run_idx: "188231 348 62",
  orchestration_v2_projection_plans_run_idx: "49 1",
  orchestration_v2_projection_plans_thread_idx: "49 2",
  orchestration_v2_projection_provider_session_bindings_thread_idx: "173 1",
  orchestration_v2_projection_provider_sessions_instance_status_idx: "91 23 13",
  orchestration_v2_projection_provider_sessions_provider_status_idx: "91 23 13",
  orchestration_v2_projection_provider_sessions_thread_idx: "91 1",
  orchestration_v2_projection_provider_threads_instance_status_idx: "445 112 56",
  orchestration_v2_projection_provider_threads_owner_idx: "445 6",
  orchestration_v2_projection_provider_threads_session_idx: "445 5",
  orchestration_v2_projection_provider_threads_thread_idx: "445 1",
  orchestration_v2_projection_provider_turns_thread_idx: "2878 7",
  orchestration_v2_projection_provider_turns_thread_ordinal_idx: "2878 7 1",
  orchestration_v2_projection_requests_recovery_idx: "5 1",
  orchestration_v2_projection_run_attempts_run_ordinal_idx: "2800 1 1",
  orchestration_v2_projection_run_attempts_thread_idx: "2800 10 1",
  orchestration_v2_projection_runs_provider_thread_idx: "2799 10",
  orchestration_v2_projection_runs_recovery_idx: "38 19 7",
  orchestration_v2_projection_runs_thread_ordinal_idx: "2799 10 1",
  orchestration_v2_projection_runs_thread_status_idx: "2799 10 8",
  orchestration_v2_projection_runtime_requests_provider_turn_idx: "80 2",
  orchestration_v2_projection_runtime_requests_thread_status_idx: "80 2 2",
  orchestration_v2_projection_subagents_child_thread_idx: "348 1",
  orchestration_v2_projection_subagents_parent_node_idx: "348 2",
  orchestration_v2_projection_subagents_provider_thread_idx: "348 2",
  orchestration_v2_projection_subagents_thread_idx: "348 5 1 1",
  orchestration_v2_projection_threads_project_updated_idx: "661 133 1",
  orchestration_v2_projection_turn_items_failed_error_idx: "71 2 1 1 1 1 1",
  orchestration_v2_projection_turn_items_node_ordinal_idx: "207116 2 1",
  orchestration_v2_projection_turn_items_provider_turn_idx: "207116 72",
  orchestration_v2_projection_turn_items_recovery_idx: "3 1",
  orchestration_v2_projection_turn_items_run_ordinal_idx: "207116 78 2",
  orchestration_v2_projection_turn_items_shell_pending_idx: "3 1 1",
  orchestration_v2_projection_turn_items_thread_ordinal_idx: "207116 314 1 1",
  orchestration_v2_projection_turn_items_thread_run_idx: "207116 314 68",
  orchestration_v2_projection_turn_items_user_message_idx: "2877 5 1 1",
  sqlite_autoindex_auth_pairing_links_1: "556 1",
  sqlite_autoindex_auth_pairing_links_2: "556 1",
  sqlite_autoindex_auth_sessions_1: "548 1",
  sqlite_autoindex_checkpoint_diff_blobs_1: "1000 10 2 1",
  sqlite_autoindex_mcp_app_model_context_1: "1000 10 1",
  sqlite_autoindex_orchestration_command_receipts_1: "301300 1",
  sqlite_autoindex_orchestration_events_1: "13869561 1",
  sqlite_autoindex_orchestration_v2_command_receipts_1: "1000 1",
  sqlite_autoindex_orchestration_v2_effect_outbox_1: "4764 1",
  sqlite_autoindex_orchestration_v2_events_1: "1000 1",
  sqlite_autoindex_orchestration_v2_legacy_imports_1: "119 1",
  sqlite_autoindex_orchestration_v2_projection_checkpoint_scopes_1: "289 1",
  sqlite_autoindex_orchestration_v2_projection_checkpoints_1: "2920 1",
  sqlite_autoindex_orchestration_v2_projection_context_handoffs_1: "101 1",
  sqlite_autoindex_orchestration_v2_projection_context_transfers_1: "188 1",
  sqlite_autoindex_orchestration_v2_projection_messages_1: "35222 1",
  sqlite_autoindex_orchestration_v2_projection_metadata_1: "1 1",
  sqlite_autoindex_orchestration_v2_projection_nodes_1: "188231 1",
  sqlite_autoindex_orchestration_v2_projection_plans_1: "49 1",
  sqlite_autoindex_orchestration_v2_projection_provider_session_bindings_1: "173 3 1",
  sqlite_autoindex_orchestration_v2_projection_provider_sessions_1: "91 1",
  sqlite_autoindex_orchestration_v2_projection_provider_threads_1: "445 1",
  sqlite_autoindex_orchestration_v2_projection_provider_turns_1: "2878 1",
  sqlite_autoindex_orchestration_v2_projection_run_attempts_1: "2800 1",
  sqlite_autoindex_orchestration_v2_projection_runs_1: "2799 1",
  sqlite_autoindex_orchestration_v2_projection_runtime_requests_1: "80 1",
  sqlite_autoindex_orchestration_v2_projection_subagents_1: "348 1",
  sqlite_autoindex_orchestration_v2_projection_threads_1: "661 1",
  sqlite_autoindex_orchestration_v2_projection_turn_items_1: "207116 1",
  sqlite_autoindex_orchestration_v2_thread_launch_workflows_1: "1000 1",
  sqlite_autoindex_orchestration_v2_turn_item_positions_1: "207116 314 1",
  sqlite_autoindex_orchestration_v2_turn_item_positions_2: "207116 314 1",
  sqlite_autoindex_projection_pending_approvals_1: "1000 1",
  sqlite_autoindex_projection_projects_1: "5 1",
  sqlite_autoindex_projection_state_1: "10 1",
  sqlite_autoindex_projection_thread_activities_1: "112980 1",
  sqlite_autoindex_projection_thread_messages_1: "23713 1",
  sqlite_autoindex_projection_thread_proposed_plans_1: "1000 1",
  sqlite_autoindex_projection_thread_pull_requests_1: "93 3 3 3 1",
  sqlite_autoindex_projection_thread_sessions_1: "66 1",
  sqlite_autoindex_projection_threads_1: "119 1",
  sqlite_autoindex_projection_turns_1: "275 5 1",
  sqlite_autoindex_projection_turns_2: "275 5 1",
  sqlite_autoindex_provider_session_runtime_1: "118 1",
  sqlite_autoindex_scheduled_task_webhook_deliveries_1: "1000 1",
  sqlite_autoindex_scheduled_task_webhook_relay_deliveries_1: "1000 1",
  sqlite_autoindex_scheduled_tasks_1: "2 1",
};

/**
 * Adds the fixed statistics for indexes that have none. Rows a database
 * already has, such as ones an older build collected with ANALYZE, are kept.
 * The server and a CLI command can open a new database at once, so the read
 * and the insert share one write transaction: sqlite_stat1 has no unique key.
 */
export const seedPlannerStatistics = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      // Analyzing sqlite_schema reads no user table. It creates sqlite_stat1
      // when missing and reloads the statistics into this connection.
      yield* sql`ANALYZE sqlite_schema`;
      const missing = yield* sql<{ readonly tbl: string; readonly idx: string }>`
        SELECT tbl_name AS tbl, name AS idx FROM sqlite_schema
        WHERE type = 'index' AND name NOT IN (SELECT idx FROM sqlite_stat1 WHERE idx IS NOT NULL)
      `;
      const rows = missing.flatMap(({ tbl, idx }) => {
        const stat = PLANNER_STATISTICS[idx];
        return stat === undefined ? [] : [{ tbl, idx, stat }];
      });
      if (rows.length === 0) return;
      yield* sql`INSERT INTO sqlite_stat1 ${sql.insert(rows)}`;
      yield* sql`ANALYZE sqlite_schema`;
    }),
  );
}).pipe(Effect.withSpan("seedPlannerStatistics"));
