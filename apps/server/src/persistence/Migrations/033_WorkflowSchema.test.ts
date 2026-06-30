import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../Layers/Sqlite.ts";
import { migrationEntries, runMigrations } from "../Migrations.ts";

/**
 * Equivalence gate for the collapsed workflow schema.
 *
 * `GOLDEN` below was captured from the real, original 23-step migration chain
 * (033 -> 055) — it is the authoritative reference. The consolidated migration
 * 033_WorkflowSchema must reproduce it EXACTLY. The dump filters to
 * `tbl_name LIKE 'workflow_%' OR tbl_name = 'projection_threads'` (the objects
 * the workflow feature owns or extends) and normalizes whitespace.
 *
 * If this test fails, the collapsed schema diverged from the chain — fix the
 * migration, do not weaken the assertion.
 */

const layer = it.layer(Layer.mergeAll(SqlitePersistenceMemory));

/** Collapse all runs of whitespace to a single space and trim. */
const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();

interface MasterRow {
  readonly type: string;
  readonly name: string;
  readonly tbl_name: string;
  readonly sql: string;
}

const GOLDEN: ReadonlyArray<MasterRow> = [
  {
    type: "table",
    name: "projection_threads",
    tbl_name: "projection_threads",
    sql: "CREATE TABLE projection_threads ( thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, branch TEXT, worktree_path TEXT, latest_turn_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT , runtime_mode TEXT NOT NULL DEFAULT 'full-access', interaction_mode TEXT NOT NULL DEFAULT 'default', model_selection_json TEXT, archived_at TEXT, latest_user_message_at TEXT, pending_approval_count INTEGER NOT NULL DEFAULT 0, pending_user_input_count INTEGER NOT NULL DEFAULT 0, has_actionable_proposed_plan INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0)",
  },
  {
    type: "index",
    name: "idx_projection_threads_project_archived_at",
    tbl_name: "projection_threads",
    sql: "CREATE INDEX idx_projection_threads_project_archived_at ON projection_threads(project_id, archived_at)",
  },
  {
    type: "index",
    name: "idx_projection_threads_project_deleted_created",
    tbl_name: "projection_threads",
    sql: "CREATE INDEX idx_projection_threads_project_deleted_created ON projection_threads(project_id, deleted_at, created_at)",
  },
  {
    type: "index",
    name: "idx_projection_threads_project_id",
    tbl_name: "projection_threads",
    sql: "CREATE INDEX idx_projection_threads_project_id ON projection_threads(project_id)",
  },
  {
    type: "index",
    name: "idx_projection_threads_shell_active",
    tbl_name: "projection_threads",
    sql: "CREATE INDEX idx_projection_threads_shell_active ON projection_threads(deleted_at, archived_at, project_id, created_at, thread_id)",
  },
  {
    type: "index",
    name: "idx_projection_threads_shell_archived",
    tbl_name: "projection_threads",
    sql: "CREATE INDEX idx_projection_threads_shell_archived ON projection_threads(deleted_at, archived_at, project_id, thread_id)",
  },
  {
    type: "table",
    name: "workflow_board_proposal",
    tbl_name: "workflow_board_proposal",
    sql: "CREATE TABLE workflow_board_proposal ( proposal_id TEXT PRIMARY KEY, board_id TEXT NOT NULL, base_version_hash TEXT NOT NULL, base_def_json TEXT NOT NULL, agent_json TEXT NOT NULL, proposed_def_json TEXT NOT NULL, rationale TEXT NOT NULL, validation_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', applied_version_hash TEXT NULL, created_at TEXT NOT NULL, resolved_at TEXT NULL )",
  },
  {
    type: "index",
    name: "idx_workflow_board_proposal_board",
    tbl_name: "workflow_board_proposal",
    sql: "CREATE INDEX idx_workflow_board_proposal_board ON workflow_board_proposal (board_id, status, created_at)",
  },
  {
    type: "table",
    name: "workflow_board_version",
    tbl_name: "workflow_board_version",
    sql: "CREATE TABLE workflow_board_version ( version_id INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT NOT NULL, version_hash TEXT NOT NULL, content_json TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL )",
  },
  {
    type: "index",
    name: "idx_workflow_board_version_board",
    tbl_name: "workflow_board_version",
    sql: "CREATE INDEX idx_workflow_board_version_board ON workflow_board_version(board_id, version_id)",
  },
  {
    type: "index",
    name: "idx_workflow_board_version_hash",
    tbl_name: "workflow_board_version",
    sql: "CREATE INDEX idx_workflow_board_version_hash ON workflow_board_version(board_id, version_hash)",
  },
  {
    type: "table",
    name: "workflow_board_webhook",
    tbl_name: "workflow_board_webhook",
    sql: "CREATE TABLE workflow_board_webhook ( board_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, token_prefix TEXT NOT NULL, created_at TEXT NOT NULL )",
  },
  {
    type: "table",
    name: "workflow_dispatch_outbox",
    tbl_name: "workflow_dispatch_outbox",
    sql: "CREATE TABLE workflow_dispatch_outbox ( dispatch_id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, step_run_id TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT, provider_instance TEXT NOT NULL, model TEXT NOT NULL, instruction TEXT NOT NULL, worktree_path TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, started_at TEXT, confirmed_at TEXT , options_json TEXT, project_id TEXT, thread_title TEXT, runtime_mode TEXT)",
  },
  {
    type: "index",
    name: "idx_dispatch_outbox_pending",
    tbl_name: "workflow_dispatch_outbox",
    sql: "CREATE INDEX idx_dispatch_outbox_pending ON workflow_dispatch_outbox(status)",
  },
  {
    type: "index",
    name: "idx_dispatch_outbox_step_run",
    tbl_name: "workflow_dispatch_outbox",
    sql: "CREATE INDEX idx_dispatch_outbox_step_run ON workflow_dispatch_outbox(step_run_id)",
  },
  {
    type: "table",
    name: "workflow_events",
    tbl_name: "workflow_events",
    sql: "CREATE TABLE workflow_events ( sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, ticket_id TEXT NOT NULL, stream_version INTEGER NOT NULL, event_type TEXT NOT NULL, occurred_at TEXT NOT NULL, payload_json TEXT NOT NULL )",
  },
  {
    type: "index",
    name: "idx_workflow_events_stream_version",
    tbl_name: "workflow_events",
    sql: "CREATE UNIQUE INDEX idx_workflow_events_stream_version ON workflow_events(ticket_id, stream_version)",
  },
  {
    type: "index",
    name: "idx_workflow_events_ticket_type_time",
    tbl_name: "workflow_events",
    sql: "CREATE INDEX idx_workflow_events_ticket_type_time ON workflow_events (ticket_id, event_type, occurred_at)",
  },
  {
    type: "table",
    name: "workflow_outbound_connection",
    tbl_name: "workflow_outbound_connection",
    sql: "CREATE TABLE workflow_outbound_connection ( connection_ref TEXT PRIMARY KEY, kind TEXT NOT NULL, display_name TEXT NOT NULL, secret_name TEXT NOT NULL, created_at TEXT NOT NULL )",
  },
  {
    type: "table",
    name: "workflow_outbound_delivery",
    tbl_name: "workflow_outbound_delivery",
    sql: "CREATE TABLE workflow_outbound_delivery ( delivery_id TEXT PRIMARY KEY, board_id TEXT NOT NULL, ticket_id TEXT NOT NULL, rule_id TEXT NOT NULL, event_sequence INTEGER NOT NULL, connection_ref TEXT NOT NULL, formatter TEXT NOT NULL, context_json TEXT NOT NULL, delivery_state TEXT NOT NULL DEFAULT 'pending', attempt_count INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NULL, created_at TEXT NOT NULL, last_error TEXT NULL, UNIQUE (event_sequence, rule_id) )",
  },
  {
    type: "index",
    name: "idx_workflow_outbound_delivery_due",
    tbl_name: "workflow_outbound_delivery",
    sql: "CREATE INDEX idx_workflow_outbound_delivery_due ON workflow_outbound_delivery (delivery_state, next_attempt_at)",
  },
  {
    type: "table",
    name: "workflow_pr_observation",
    tbl_name: "workflow_pr_observation",
    sql: "CREATE TABLE workflow_pr_observation ( observation_id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, dedup_key TEXT NOT NULL UNIQUE, event_name TEXT NOT NULL, payload_json TEXT NOT NULL, message_body TEXT NULL, status TEXT NOT NULL DEFAULT 'pending', attempt_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL )",
  },
  {
    type: "index",
    name: "idx_workflow_pr_observation_pending",
    tbl_name: "workflow_pr_observation",
    sql: "CREATE INDEX idx_workflow_pr_observation_pending ON workflow_pr_observation (status, ticket_id)",
  },
  {
    type: "table",
    name: "workflow_pr_state",
    tbl_name: "workflow_pr_state",
    sql: "CREATE TABLE workflow_pr_state ( ticket_id TEXT PRIMARY KEY, pr_number INTEGER NOT NULL, pr_url TEXT NOT NULL, branch TEXT NOT NULL, remote_name TEXT NOT NULL, repo TEXT NOT NULL, pr_state TEXT NOT NULL DEFAULT 'open', last_head_sha TEXT NULL, last_ci_state TEXT NULL, last_review_decision TEXT NULL, last_comment_cursor TEXT NULL, updated_at TEXT NOT NULL )",
  },
  {
    type: "index",
    name: "idx_workflow_pr_state_open",
    tbl_name: "workflow_pr_state",
    sql: "CREATE INDEX idx_workflow_pr_state_open ON workflow_pr_state (pr_state) WHERE pr_state = 'open'",
  },
  {
    type: "table",
    name: "workflow_project_trust",
    tbl_name: "workflow_project_trust",
    sql: "CREATE TABLE workflow_project_trust ( project_id TEXT PRIMARY KEY, trusted_at TEXT NOT NULL )",
  },
  {
    type: "table",
    name: "workflow_script_run",
    tbl_name: "workflow_script_run",
    sql: "CREATE TABLE workflow_script_run ( script_run_id TEXT PRIMARY KEY, step_run_id TEXT NOT NULL UNIQUE, ticket_id TEXT NOT NULL, script_thread_id TEXT NOT NULL, terminal_id TEXT NOT NULL, status TEXT NOT NULL, exit_code INTEGER, signal INTEGER, started_at TEXT NOT NULL, finished_at TEXT )",
  },
  {
    type: "index",
    name: "idx_workflow_script_run_status",
    tbl_name: "workflow_script_run",
    sql: "CREATE INDEX idx_workflow_script_run_status ON workflow_script_run(status)",
  },
  {
    type: "index",
    name: "idx_workflow_script_run_ticket",
    tbl_name: "workflow_script_run",
    sql: "CREATE INDEX idx_workflow_script_run_ticket ON workflow_script_run(ticket_id)",
  },
  {
    type: "table",
    name: "workflow_setup_run",
    tbl_name: "workflow_setup_run",
    sql: "CREATE TABLE workflow_setup_run ( setup_run_id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL UNIQUE, worktree_ref TEXT NOT NULL, status TEXT NOT NULL, exit_code INTEGER, started_at TEXT NOT NULL, finished_at TEXT )",
  },
  {
    type: "table",
    name: "workflow_webhook_delivery",
    tbl_name: "workflow_webhook_delivery",
    sql: "CREATE TABLE workflow_webhook_delivery ( board_id TEXT NOT NULL, delivery_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (board_id, delivery_id) )",
  },
];

const GOLDEN_PROJECTION_THREADS_COLUMNS =
  "thread_id,project_id,title,branch,worktree_path,latest_turn_id,created_at,updated_at,deleted_at,runtime_mode,interaction_mode,model_selection_json,archived_at,latest_user_message_at,pending_approval_count,pending_user_input_count,has_actionable_proposed_plan,hidden";

layer("033_WorkflowSchema", (it) => {
  it.effect("migration entry exists at id 33", () =>
    Effect.gen(function* () {
      assert.isTrue(migrationEntries.some(([id, name]) => id === 33 && name === "WorkflowSchema"));
    }),
  );

  it.effect("collapsed schema equals the golden 033->055 chain schema", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 33 });

      const rows = yield* sql<MasterRow>`
        SELECT type, name, tbl_name, sql
        FROM sqlite_master
        WHERE (tbl_name LIKE 'workflow_%' OR tbl_name = 'projection_threads')
          AND tbl_name != 'workflow_notification_outbox'
          AND tbl_name != 'workflow_agent_session'
          AND sql IS NOT NULL
        ORDER BY tbl_name ASC, type DESC, name ASC
      `;

      const actual = rows.map((row) => ({
        type: row.type,
        name: row.name,
        tbl_name: row.tbl_name,
        sql: normalize(row.sql),
      }));

      assert.deepEqual(actual, GOLDEN as Array<MasterRow>);
    }),
  );

  it.effect("projection_threads columns match the golden chain (incl. hidden)", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations();

      const cols = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
      assert.strictEqual(cols.map((c) => c.name).join(","), GOLDEN_PROJECTION_THREADS_COLUMNS);
    }),
  );

  // --- Readable targeted assertions for documentation value ---

  it.effect("projection_threads.hidden present", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      const cols = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
      assert.isTrue(cols.some((c) => c.name === "hidden"));
    }),
  );

  it.effect("workflow_pr_observation.attempt_count present and dedup_key is UNIQUE", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();

      const cols = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(workflow_pr_observation)
      `;
      assert.isTrue(cols.some((c) => c.name === "attempt_count"));

      yield* sql`
        INSERT INTO workflow_pr_observation
          (observation_id, ticket_id, dedup_key, event_name, payload_json, status, created_at)
        VALUES
          ('obs-1', 'ticket-a', 'dedup-xyz', 'ci_check', '{}', 'pending', '2026-01-01T00:00:00Z')
      `;
      const duplicate = yield* Effect.exit(sql`
        INSERT INTO workflow_pr_observation
          (observation_id, ticket_id, dedup_key, event_name, payload_json, status, created_at)
        VALUES
          ('obs-2', 'ticket-b', 'dedup-xyz', 'ci_check', '{}', 'pending', '2026-01-01T00:00:00Z')
      `);
      assert.strictEqual(duplicate._tag, "Failure");
    }),
  );

  it.effect("partial open index on workflow_pr_state present", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      const indexes = yield* sql<{ readonly name: string }>`PRAGMA index_list(workflow_pr_state)`;
      assert.isTrue(indexes.some((idx) => idx.name === "idx_workflow_pr_state_open"));
    }),
  );

  // --- Folded-in coverage from the former 034 (BoardNotifications) ---

  it.effect("workflow_notification_outbox table exists with expected columns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();

      const cols = yield* sql<{
        readonly name: string;
        readonly type: string;
        readonly notnull: number;
        readonly pk: number;
      }>`PRAGMA table_info(workflow_notification_outbox)`;

      assert.deepEqual(
        cols.map((c) => c.name),
        [
          "outbox_id",
          "ticket_id",
          "board_id",
          "sequence",
          "status",
          "attention_kind",
          "attention_reason",
          "delivery_state",
          "attempt_count",
          "created_at",
        ],
      );

      assert.strictEqual(cols.find((c) => c.name === "outbox_id")!.pk, 1);
      assert.strictEqual(cols.find((c) => c.name === "ticket_id")!.notnull, 1);
      assert.strictEqual(cols.find((c) => c.name === "sequence")!.type, "INTEGER");
      assert.strictEqual(cols.find((c) => c.name === "attention_kind")!.notnull, 0);
      assert.strictEqual(cols.find((c) => c.name === "delivery_state")!.notnull, 1);
    }),
  );

  it.effect("workflow_notification_outbox.sequence is UNIQUE", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();

      yield* sql`
        INSERT INTO workflow_notification_outbox
          (outbox_id, ticket_id, board_id, sequence, status, delivery_state, created_at)
        VALUES
          ('outbox-1', 'ticket-a', 'board-x', 42, 'pending', 'pending', '2026-01-01T00:00:00Z')
      `;
      const duplicate = yield* Effect.exit(sql`
        INSERT INTO workflow_notification_outbox
          (outbox_id, ticket_id, board_id, sequence, status, delivery_state, created_at)
        VALUES
          ('outbox-2', 'ticket-b', 'board-y', 42, 'pending', 'pending', '2026-01-01T00:00:00Z')
      `);
      assert.strictEqual(duplicate._tag, "Failure");
    }),
  );

  it.effect("idx_workflow_notification_outbox_pending index exists", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(workflow_notification_outbox)
      `;
      assert.isTrue(indexes.some((idx) => idx.name === "idx_workflow_notification_outbox_pending"));
    }),
  );

  it.effect("projection_ticket has attention_kind and attention_reason columns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      const cols = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_ticket)`;
      const colNames = new Set(cols.map((c) => c.name));
      assert.isTrue(colNames.has("attention_kind"), "attention_kind column missing");
      assert.isTrue(colNames.has("attention_reason"), "attention_reason column missing");
    }),
  );

  it.effect("projection_ticket has current_lane_entered_at column", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      const cols = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_ticket)`;
      assert.isTrue(
        cols.some((c) => c.name === "current_lane_entered_at"),
        "current_lane_entered_at column missing",
      );
    }),
  );

  it.effect("idx_workflow_events_ticket_type_time index exists on workflow_events", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(workflow_events)
      `;
      assert.isTrue(
        indexes.some((idx) => idx.name === "idx_workflow_events_ticket_type_time"),
        "idx_workflow_events_ticket_type_time index missing",
      );
    }),
  );

  // --- Folded-in coverage from the former 035 (WorkSources) ---

  it.effect("work_source_connection table exists with expected columns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      const cols = yield* sql<{ readonly name: string; readonly pk: number }>`
        PRAGMA table_info(work_source_connection)
      `;
      assert.deepEqual(
        cols.map((c) => c.name),
        [
          "connection_ref",
          "provider",
          "display_name",
          "auth_mode",
          "token_secret_name",
          "base_url",
          "auth_email",
          "created_at",
        ],
      );
      assert.strictEqual(cols.find((c) => c.name === "connection_ref")!.pk, 1);
    }),
  );

  it.effect("work_source_mapping table exists with expected columns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      const cols = yield* sql<{ readonly name: string; readonly pk: number }>`
        PRAGMA table_info(work_source_mapping)
      `;
      assert.deepEqual(
        cols.map((c) => c.name),
        [
          "mapping_id",
          "board_id",
          "source_id",
          "provider",
          "external_id",
          "ticket_id",
          "provider_version",
          "content_hash",
          "lifecycle",
          "sync_status",
          "source_metadata_json",
          "created_at",
          "last_synced_at",
        ],
      );
      assert.strictEqual(cols.find((c) => c.name === "mapping_id")!.pk, 1);
    }),
  );

  it.effect("work_source_state table exists with composite primary key", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      const cols = yield* sql<{
        readonly name: string;
        readonly pk: number;
        readonly type: string;
      }>`
        PRAGMA table_info(work_source_state)
      `;
      assert.deepEqual(
        cols.map((c) => c.name),
        [
          "board_id",
          "source_id",
          "cursor_or_etag",
          "last_full_run_at",
          "backoff_until",
          "consecutive_failures",
          "last_error",
        ],
      );
      assert.isAbove(cols.find((c) => c.name === "board_id")!.pk, 0);
      assert.isAbove(cols.find((c) => c.name === "source_id")!.pk, 0);
    }),
  );

  it.effect("unique indexes on work_source_mapping exist and enforce uniqueness", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();

      const objects = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index'
          AND name IN ('idx_work_source_mapping_external', 'idx_work_source_mapping_ticket')
        ORDER BY name
      `;
      const indexNames = new Set(objects.map((o) => o.name));
      assert.isTrue(indexNames.has("idx_work_source_mapping_external"));
      assert.isTrue(indexNames.has("idx_work_source_mapping_ticket"));

      yield* sql`
        INSERT INTO work_source_mapping
          (mapping_id, board_id, source_id, provider, external_id, ticket_id, content_hash, lifecycle, created_at, last_synced_at)
        VALUES
          ('map-1', 'board-a', 'src-1', 'github', 'ext-1', 'ticket-x', 'hash-1', 'open', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
      `;
      const duplicate = yield* Effect.exit(sql`
        INSERT INTO work_source_mapping
          (mapping_id, board_id, source_id, provider, external_id, ticket_id, content_hash, lifecycle, created_at, last_synced_at)
        VALUES
          ('map-2', 'board-b', 'src-2', 'github', 'ext-2', 'ticket-x', 'hash-2', 'open', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
      `);
      assert.strictEqual(duplicate._tag, "Failure");
    }),
  );

  it.effect("33 is the highest migration entry", () =>
    Effect.gen(function* () {
      const highest = migrationEntries.reduce((max, [id]) => (id > max ? id : max), 0);
      assert.strictEqual(highest, 33);
      const top = migrationEntries.find(([id]) => id === highest);
      assert.strictEqual(top?.[1], "WorkflowSchema");
    }),
  );

  it.effect("creates the outbound tables", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();

      const rows = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('workflow_outbound_connection', 'workflow_outbound_delivery')
        ORDER BY name
      `;
      const names = new Set(rows.map((r) => r.name));
      assert.isTrue(
        names.has("workflow_outbound_connection"),
        "workflow_outbound_connection table missing",
      );
      assert.isTrue(
        names.has("workflow_outbound_delivery"),
        "workflow_outbound_delivery table missing",
      );
    }),
  );

  // --- Folded-in coverage from the former 034 (WorkflowAgentSession) ---

  it.effect("workflow_agent_session table exists with composite primary key", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();

      const cols = yield* sql<{ readonly name: string; readonly pk: number }>`
        PRAGMA table_info(workflow_agent_session)
      `;
      assert.deepStrictEqual(
        cols.map((c) => c.name),
        ["ticket_id", "lane_key", "agent_key", "thread_id", "created_at", "last_used_at"],
      );
      assert.deepStrictEqual(
        cols
          .filter((c) => c.pk > 0)
          .sort((a, b) => a.pk - b.pk)
          .map((c) => c.name),
        ["ticket_id", "lane_key", "agent_key"],
      );
    }),
  );

  it.effect("workflow_agent_session has ticket and thread indexes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();

      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(workflow_agent_session)
      `;
      const names = new Set(indexes.map((i) => i.name));
      assert.isTrue(
        names.has("idx_workflow_agent_session_ticket"),
        "idx_workflow_agent_session_ticket missing",
      );
      assert.isTrue(
        names.has("idx_workflow_agent_session_thread"),
        "idx_workflow_agent_session_thread missing",
      );
    }),
  );

  // --- Folded-in coverage from the former 035 (TicketMessageEditedAt) ---

  it.effect("projection_ticket_message has edited_at column", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();

      const cols = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_ticket_message)
      `;
      assert.isTrue(
        cols.some((c) => c.name === "edited_at"),
        "edited_at column missing on projection_ticket_message",
      );
    }),
  );

  // --- workflow_board_proposal (E2) ---

  it.effect("workflow_board_proposal table has expected columns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();

      const cols = yield* sql<{
        readonly name: string;
        readonly notnull: number;
        readonly pk: number;
      }>`
        PRAGMA table_info(workflow_board_proposal)
      `;
      assert.deepEqual(
        cols.map((c) => c.name),
        [
          "proposal_id",
          "board_id",
          "base_version_hash",
          "base_def_json",
          "agent_json",
          "proposed_def_json",
          "rationale",
          "validation_json",
          "status",
          "applied_version_hash",
          "created_at",
          "resolved_at",
        ],
      );
      assert.strictEqual(cols.find((c) => c.name === "proposal_id")!.pk, 1);
      assert.strictEqual(cols.find((c) => c.name === "board_id")!.notnull, 1);
      assert.strictEqual(
        cols.find((c) => c.name === "applied_version_hash")!.notnull,
        0,
        "applied_version_hash should be nullable",
      );
      assert.strictEqual(
        cols.find((c) => c.name === "resolved_at")!.notnull,
        0,
        "resolved_at should be nullable",
      );
    }),
  );

  it.effect("idx_workflow_board_proposal_board index exists", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();

      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(workflow_board_proposal)
      `;
      assert.isTrue(
        indexes.some((idx) => idx.name === "idx_workflow_board_proposal_board"),
        "idx_workflow_board_proposal_board index missing",
      );
    }),
  );
});
