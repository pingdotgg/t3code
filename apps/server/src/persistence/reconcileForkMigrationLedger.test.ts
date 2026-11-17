import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import DesktopPairingMigration from "./Migrations/099_AuthDesktopPairingSessionTtl.ts";
import RealtimeVoiceHistoryResumeMigration from "./Migrations/100_RealtimeVoiceHistoryResume.ts";
import { reconcileForkMigrationLedger } from "./reconcileForkMigrationLedger.ts";

const forkHistory = [
  [46, "ProjectionSubagentRuns"],
  [47, "ProjectionThreadGoal"],
  [48, "ProjectionSubagentTranscripts"],
  [49, "ProjectionThreadsVoiceNotifications"],
  [50, "ProjectionThreadGoalLoop"],
  [51, "NativeChildRuns"],
  [52, "ProjectionThreadMessagesOrigin"],
  [53, "RepairAutomaticSettlementTimestamps"],
  [54, "ProjectionProjectIcon"],
  [55, "ProjectionThreadBranchPullRequest"],
  [56, "ProjectionThreadsActiveOrderKey"],
  [57, "ThreadExperiments"],
  [58, "NativeChildRunOptions"],
  [59, "NativeChildMessaging"],
  [60, "NativeChildDeliveryBatches"],
  [61, "ProjectionThreadPullRequests"],
  [62, "ProjectionThreadMessageContext"],
  [63, "ProjectionThreadTitleState"],
  [64, "ProjectionProjectsSchedules"],
  [65, "PullRequestFilesViewed"],
  [66, "ProjectionSubagentRunsFastMode"],
  [67, "ProjectionThreadsAutoSettleDisabledAt"],
] as const;

const forkTableNames = [
  "native_child_delivery_batch_runs",
  "native_child_delivery_batches",
  "native_child_messages",
  "native_child_runs",
  "projection_subagent_runs",
  "subagent_run_number_reservations",
  "subagent_transcript_evictions",
  "subagent_transcript_items",
  "thread_experiments",
] as const;

const readHistory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly migration_id: number;
    readonly name: string;
    readonly created_at: string;
  }>`SELECT migration_id, name, created_at FROM effect_sql_migrations ORDER BY migration_id`;
});

// The fork tables keep only the columns needed to reproduce their foreign-key graph.
const seedForkDatabase = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 54 });
  yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 46`;

  yield* sql`ALTER TABLE projection_threads ADD COLUMN goal TEXT`;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN voice_notifications INTEGER NOT NULL DEFAULT 1`;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN goal_loop_json TEXT`;
  yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN origin TEXT`;
  yield* sql`ALTER TABLE projection_projects ADD COLUMN schedules_json TEXT NOT NULL DEFAULT '[]'`;

  yield* sql`
    CREATE TABLE subagent_run_number_reservations (
      run_number INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL UNIQUE
    )
  `;
  yield* sql`
    CREATE TABLE projection_subagent_runs (
      run_id TEXT PRIMARY KEY,
      run_number INTEGER NOT NULL UNIQUE,
      run_birth TEXT,
      last_transcript_sequence INTEGER,
      fast_mode INTEGER CHECK (fast_mode IS NULL OR fast_mode IN (0, 1)),
      FOREIGN KEY (run_number) REFERENCES subagent_run_number_reservations(run_number)
    )
  `;
  yield* sql`
    CREATE TABLE subagent_transcript_items (
      run_id TEXT NOT NULL,
      transcript_sequence INTEGER NOT NULL,
      PRIMARY KEY (run_id, transcript_sequence),
      FOREIGN KEY (run_id) REFERENCES projection_subagent_runs(run_id) ON DELETE CASCADE
    )
  `;
  yield* sql`
    CREATE TABLE subagent_transcript_evictions (
      run_id TEXT NOT NULL,
      from_sequence INTEGER NOT NULL,
      PRIMARY KEY (run_id, from_sequence),
      FOREIGN KEY (run_id) REFERENCES projection_subagent_runs(run_id) ON DELETE CASCADE
    )
  `;
  yield* sql`
    CREATE TABLE native_child_runs (
      run_id TEXT PRIMARY KEY,
      run_number INTEGER NOT NULL UNIQUE,
      requested_options_json TEXT,
      agent_id TEXT,
      FOREIGN KEY (run_number) REFERENCES subagent_run_number_reservations(run_number)
    )
  `;
  yield* sql`
    CREATE TABLE native_child_messages (
      parent_thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      PRIMARY KEY (parent_thread_id, message_id)
    )
  `;
  yield* sql`
    CREATE TABLE native_child_delivery_batches (
      batch_id TEXT PRIMARY KEY
    )
  `;
  yield* sql`
    CREATE TABLE native_child_delivery_batch_runs (
      batch_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      PRIMARY KEY (batch_id, run_id),
      FOREIGN KEY (batch_id) REFERENCES native_child_delivery_batches(batch_id),
      FOREIGN KEY (run_id) REFERENCES native_child_runs(run_id)
    )
  `;
  yield* sql`
    CREATE TABLE thread_experiments (
      thread_id TEXT PRIMARY KEY,
      FOREIGN KEY (thread_id) REFERENCES projection_threads(thread_id) ON DELETE CASCADE
    )
  `;

  yield* sql`
    INSERT INTO subagent_run_number_reservations (run_number, run_id) VALUES (1, 'fork-run')
  `;
  yield* sql`
    INSERT INTO projection_subagent_runs (run_id, run_number) VALUES ('fork-run', 1)
  `;
  yield* sql`
    INSERT INTO subagent_transcript_items (run_id, transcript_sequence) VALUES ('fork-run', 1)
  `;
  yield* sql`
    INSERT INTO subagent_transcript_evictions (run_id, from_sequence) VALUES ('fork-run', 1)
  `;
  yield* sql`
    INSERT INTO native_child_runs (run_id, run_number) VALUES ('native-run', 1)
  `;
  yield* sql`INSERT INTO native_child_delivery_batches (batch_id) VALUES ('batch')`;
  yield* sql`
    INSERT INTO native_child_delivery_batch_runs (batch_id, run_id) VALUES ('batch', 'native-run')
  `;

  for (const [migrationId, name] of forkHistory) {
    yield* sql`
      INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${migrationId}, ${name})
    `;
  }
});

describe("fork migration ledger reconciliation", () => {
  it.effect("leaves a database without a migration ledger unchanged", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      assert.deepStrictEqual(yield* reconcileForkMigrationLedger(), []);
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'effect_sql_migrations'`,
        [],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("leaves a pristine upstream ledger unchanged", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 54 });
      const before = yield* readHistory;
      assert.deepStrictEqual(yield* reconcileForkMigrationLedger(), []);
      assert.deepStrictEqual(yield* readHistory, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("leaves a site-local upstream migration name unchanged", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 40 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (41, 'ThreadSummaryTimeline')
      `;
      const before = yield* readHistory;

      assert.deepStrictEqual(yield* reconcileForkMigrationLedger(), []);
      assert.deepStrictEqual(yield* readHistory, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("rejects a fork-only migration name at an unexpected id", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 40 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (41, 'ProjectionThreadGoal')
      `;
      const before = yield* readHistory;

      const error = yield* Effect.flip(reconcileForkMigrationLedger());
      assert.isTrue(error instanceof Migrator.MigrationError);
      if (error instanceof Migrator.MigrationError) {
        assert.strictEqual(error.kind, "BadState");
      }
      assert.deepStrictEqual(yield* readHistory, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("rewrites the exact fork ledger, prunes fork tables, and runs migrations from 55", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedForkDatabase;

      assert.deepStrictEqual(yield* runMigrations(), migrationManifest.slice(54));
      const history = yield* readHistory;
      assert.deepStrictEqual(
        history.map(({ migration_id, name }) => [migration_id, name] as const),
        migrationManifest,
      );
      assert.deepStrictEqual(
        yield* sql<{ readonly name: string }>`
          SELECT name FROM sqlite_master
          WHERE type = 'table' AND name IN ${sql.in(forkTableNames)}
        `,
        [],
      );
      assert.deepStrictEqual(
        yield* sql<{ readonly name: string }>`
          SELECT name FROM sqlite_master
          WHERE type = 'table' AND name = 'orchestration_v2_events'
        `,
        [{ name: "orchestration_v2_events" }],
      );

      const threadColumns = yield* sql<{
        readonly name: string;
      }>`PRAGMA table_info(projection_threads)`;
      const messageColumns = yield* sql<{
        readonly name: string;
      }>`PRAGMA table_info(projection_thread_messages)`;
      const projectColumns = yield* sql<{
        readonly name: string;
      }>`PRAGMA table_info(projection_projects)`;
      assert.isTrue(threadColumns.some(({ name }) => name === "goal"));
      assert.isTrue(threadColumns.some(({ name }) => name === "goal_loop_json"));
      assert.isTrue(threadColumns.some(({ name }) => name === "voice_notifications"));
      assert.isTrue(messageColumns.some(({ name }) => name === "origin"));
      assert.isTrue(projectColumns.some(({ name }) => name === "schedules_json"));
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("rejects a partial fork signature without changing the ledger", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedForkDatabase;
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 66`;
      const before = yield* readHistory;

      const error = yield* Effect.flip(reconcileForkMigrationLedger());
      assert.isTrue(error instanceof Migrator.MigrationError);
      if (error instanceof Migrator.MigrationError) {
        assert.strictEqual(error.kind, "BadState");
      }
      assert.deepStrictEqual(yield* readHistory, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("allows a safe retry after reconciliation and then runs migration 55", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedForkDatabase;
      assert.deepStrictEqual(yield* reconcileForkMigrationLedger(), []);
      const before = yield* readHistory;
      assert.deepStrictEqual(
        before.map(({ migration_id, name }) => [migration_id, name] as const),
        migrationManifest.slice(0, 54),
      );
      assert.strictEqual(before.at(-1)?.migration_id, 54);
      assert.deepStrictEqual(yield* reconcileForkMigrationLedger(), []);
      assert.deepStrictEqual(yield* readHistory, before);

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 55 }), [
        [55, "OrchestrationV2"],
      ]);
      assert.deepStrictEqual(
        yield* sql<{ readonly name: string }>`
          SELECT name FROM sqlite_master
          WHERE type = 'table' AND name = 'orchestration_v2_events'
        `,
        [{ name: "orchestration_v2_events" }],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("leaves a fully migrated upstream database unchanged", () =>
    Effect.gen(function* () {
      yield* seedForkDatabase;
      yield* runMigrations();
      const before = yield* readHistory;
      assert.deepStrictEqual(yield* reconcileForkMigrationLedger(), []);
      assert.deepStrictEqual(yield* readHistory, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("leaves future upstream migrations unchanged and allows migration startup", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      const firstFutureId = migrationManifest.length + 1;
      for (let migrationId = firstFutureId; migrationId < firstFutureId + 14; migrationId++) {
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (${migrationId}, ${`FutureUpstreamMigration${migrationId}`})
        `;
      }
      const before = yield* readHistory;

      assert.deepStrictEqual(yield* reconcileForkMigrationLedger(), []);
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* readHistory, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("rejects fork rows when orchestration v2 tables already exist", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedForkDatabase;
      yield* sql`CREATE TABLE orchestration_v2_events (sequence INTEGER PRIMARY KEY)`;
      const before = yield* readHistory;

      const error = yield* Effect.flip(reconcileForkMigrationLedger());
      assert.isTrue(error instanceof Migrator.MigrationError);
      if (error instanceof Migrator.MigrationError) {
        assert.strictEqual(error.kind, "BadState");
      }
      assert.deepStrictEqual(yield* readHistory, before);
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'orchestration_v2_events'`,
        [{ name: "orchestration_v2_events" }],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("rolls back ledger deletions when reconciliation fails", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedForkDatabase;
      yield* sql`
        CREATE TRIGGER fail_fork_reconciliation BEFORE UPDATE ON effect_sql_migrations
        WHEN OLD.migration_id = 53
        BEGIN SELECT RAISE(ABORT, 'injected failure'); END
      `;
      const before = yield* readHistory;

      assert.isTrue(Exit.isFailure(yield* Effect.exit(reconcileForkMigrationLedger())));
      assert.deepStrictEqual(yield* readHistory, before);
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN ${sql.in(forkTableNames)}
      `;
      assert.strictEqual(tables.length, forkTableNames.length);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});

describe("desktop pairing backport upgrade", () => {
  it.effect(
    "retains grant policy while applying upstream migrations after the frozen release",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 56 });
        yield* DesktopPairingMigration;
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (57, 'AuthDesktopPairingSessionTtl')`;
        yield* sql`INSERT INTO auth_pairing_links (id, credential, method, scopes, subject, created_at, expires_at, desktop_session_ttl_days)
        VALUES ('kept-grant', 'test-credential', 'one-time-token', '[]', 'one-time-token', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 180)`;
        yield* runMigrations();
        const history = yield* readHistory;
        assert.strictEqual(
          history.find((row) => row.migration_id === 57)?.name,
          "ScheduledTaskWebhooks",
        );
        assert.strictEqual(
          history.find((row) => row.migration_id === 99)?.name,
          "AuthDesktopPairingSessionTtl",
        );
        assert.strictEqual(history.length, migrationManifest.length);
        assert.deepStrictEqual(
          yield* sql`SELECT desktop_session_ttl_days FROM auth_pairing_links WHERE id = 'kept-grant'`,
          [{ desktop_session_ttl_days: 180 }],
        );
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
  it.effect("rejects an unexpected backport history without changing its ledger", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 56 });
      yield* DesktopPairingMigration;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (57, 'AuthDesktopPairingSessionTtl'), (58, 'UnexpectedMigration')`;
      const before = yield* readHistory;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(yield* readHistory, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});

const forkRenumberTail = [
  [69, "ThreadMessageSearch"],
  [70, "PeerLinks"],
  [71, "PeerLinkFence"],
  [72, "WaitingLinkRequestIndex"],
  [73, "ActiveTurnItemIndexes"],
  [74, "ExcludeAttachmentPlaceholdersFromSearch"],
  [75, "SubagentDeliveryState"],
  [76, "ProjectionProjectsPinArchive"],
  [77, "RepairBooleanSettledOverride"],
  [78, "DropOrchestrationEventCorrelationIndex"],
  [79, "DelegatedRecoveryIndexes"],
  [80, "ScheduledTaskThreadMode"],
  [81, "ProjectionMessageSearchText"],
  [82, "TurnItemConversationIndex"],
  [83, "CommandReadIndexes"],
  [84, "LastExecutedRunIndex"],
  [85, "TurnItemCounts"],
  [86, "QueuedTurnInputIndex"],
  [87, "ProjectionProjectsCustomTitle"],
  [88, "TurnItemTypeStatusIndex"],
  [89, "ShellThreadReadIndexes"],
  [90, "AuthConnectDevices"],
  [91, "AuthConnectDeniedRequests"],
  [92, "QueuedTurnInputIndexJsonValid"],
  [93, "ProviderTurnAttemptIndex"],
  [94, "TurnItemMessageOrdinalIndex"],
  [95, "TurnItemInlineWorkOutput"],
  [96, "RepairStaleTitleRegeneration"],
  [97, "IssueTrackerBindings"],
  [98, "ActiveShellIndexIndexes"],
  [99, "AuthDesktopPairingSessionTtl"],
  [100, "RealtimeVoiceHistoryResume"],
];

const readRenumberTail = Effect.map(readHistory, (history) =>
  history.filter((row) => row.migration_id >= 69).map((row) => [row.migration_id, row.name]),
);

// Upstream 070–098 must have run, not just been recorded.
const assertUpstreamSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const hasColumn = (table: string, column: string) =>
    Effect.map(
      sql<{ readonly name: string }>`SELECT name FROM pragma_table_info(${table})`,
      (columns) => columns.some((row) => row.name === column),
    );
  assert.isTrue(yield* hasColumn("peer_environment_links", "fenced"));
  assert.isTrue(
    yield* hasColumn("orchestration_v2_projection_subagents", "completion_delivery_state"),
  );
  assert.isTrue(yield* hasColumn("projection_projects", "pinned_at"));
  assert.isTrue(yield* hasColumn("scheduled_tasks", "thread_mode"));
  assert.isTrue(yield* hasColumn("orchestration_v2_projection_messages", "search_text"));
  assert.isTrue(yield* hasColumn("projection_projects", "has_custom_title"));
  assert.isTrue(yield* hasColumn("auth_pairing_links", "connect_denied"));
  assert.isTrue(yield* hasColumn("auth_pairing_links", "desktop_session_ttl_days"));
  assert.isTrue(yield* hasColumn("issue_tracker_bindings", "scope"));
  const indexes = yield* sql`
    SELECT name FROM sqlite_master
    WHERE type = 'index' AND name IN (
      'orchestration_v2_projection_turn_items_waiting_link_idx',
      'orchestration_v2_projection_turn_items_active_ordinal_idx',
      'orchestration_v2_projection_runs_delegated_delivery_idx',
      'orchestration_v2_projection_turn_items_queued_input_idx',
      'orchestration_v2_projection_threads_active_shell_idx'
    )
  `;
  assert.strictEqual(indexes.length, 5);
});

describe("fork migration renumber", () => {
  it.effect.each([
    [68, 69, 70],
    [69, 70, 71],
    [72, 73, 74],
    [76, 77, 78],
    [79, 80, 81],
    [80, 81, 82],
    [92, 93, 94],
    [96, 97, 98],
  ] as const)(
    "reruns fork migrations recorded after upstream migration %i",
    ([throughId, pairingId, voiceId]) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: throughId });
        yield* DesktopPairingMigration;
        yield* RealtimeVoiceHistoryResumeMigration;
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${pairingId}, 'AuthDesktopPairingSessionTtl'), (${voiceId}, 'RealtimeVoiceHistoryResume')`;
        yield* sql`INSERT INTO auth_pairing_links (id, credential, method, scopes, subject, created_at, expires_at, desktop_session_ttl_days)
          VALUES ('kept-grant', 'test-credential', 'one-time-token', '[]', 'one-time-token', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 30)`;
        yield* runMigrations();
        assert.deepStrictEqual(yield* readRenumberTail, forkRenumberTail);
        yield* assertUpstreamSchema;
        assert.deepStrictEqual(
          yield* sql`SELECT desktop_session_ttl_days FROM auth_pairing_links WHERE id = 'kept-grant'`,
          [{ desktop_session_ttl_days: 30 }],
        );
        assert.deepStrictEqual(yield* runMigrations(), []);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("applies the full manifest to a fresh database", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      assert.deepStrictEqual(
        (yield* readHistory).map((row) => [row.migration_id, row.name]),
        migrationManifest.map(([id, name]) => [id, name]),
      );
      yield* assertUpstreamSchema;
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("adds only the fork migrations to an upstream database at 098", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 98 });
      const before = yield* readHistory;
      const executed = yield* runMigrations();
      assert.deepStrictEqual(
        executed.map(([id, name]) => [id, name]),
        [
          [99, "AuthDesktopPairingSessionTtl"],
          [100, "RealtimeVoiceHistoryResume"],
        ],
      );
      assert.deepStrictEqual((yield* readHistory).slice(0, before.length), before);
      assert.deepStrictEqual(yield* readRenumberTail, forkRenumberTail);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
