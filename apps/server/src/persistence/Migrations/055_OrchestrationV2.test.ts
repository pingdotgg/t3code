import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { migrationEntries, runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("055_OrchestrationV2", (it) => {
  it.effect("keeps released migrations contiguous", () =>
    Effect.sync(() => {
      assert.deepStrictEqual(
        migrationEntries.map(([id]) => id),
        Array.from({ length: 61 }, (_, index) => index + 1),
      );
    }),
  );

  it.effect("upgrades released schema 53 through the latest migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 53 });

      const executed = yield* runMigrations();
      assert.deepStrictEqual(executed, [
        [54, "ProjectionThreadsAutoSettleDisabledAt"],
        [55, "OrchestrationV2"],
        [56, "RemoveRedundantProjectionIndexes"],
        [57, "ScheduledTaskWebhooks"],
        [58, "WebhookRelayDeliveries"],
        [59, "McpAppModelContext"],
        [60, "ThreadSnapshotWindowIndexes"],
        [61, "ProjectionThreadSweepIndexes"],
      ]);
      assert.deepStrictEqual(yield* runMigrations(), []);

      const migrations = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
      }>`
        SELECT migration_id, name
        FROM effect_sql_migrations
        WHERE migration_id >= 48
        ORDER BY migration_id
      `;
      assert.deepStrictEqual(migrations, [
        { migration_id: 48, name: "ProjectionThreadBranchPullRequest" },
        { migration_id: 49, name: "ProjectionThreadsActiveOrderKey" },
        { migration_id: 50, name: "ProjectionThreadPullRequests" },
        { migration_id: 51, name: "ProjectionThreadMessageContext" },
        { migration_id: 52, name: "ProjectionThreadTitleState" },
        { migration_id: 53, name: "PullRequestFilesViewed" },
        { migration_id: 54, name: "ProjectionThreadsAutoSettleDisabledAt" },
        { migration_id: 55, name: "OrchestrationV2" },
        { migration_id: 56, name: "RemoveRedundantProjectionIndexes" },
        { migration_id: 57, name: "ScheduledTaskWebhooks" },
        { migration_id: 58, name: "WebhookRelayDeliveries" },
        { migration_id: 59, name: "McpAppModelContext" },
        { migration_id: 60, name: "ThreadSnapshotWindowIndexes" },
        { migration_id: 61, name: "ProjectionThreadSweepIndexes" },
      ]);

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN (
            'orchestration_v2_projection_threads',
            'orchestration_v2_projection_subagents',
            'orchestration_v2_effect_outbox',
            'orchestration_v2_turn_item_positions',
            'orchestration_v2_projection_metadata',
            'orchestration_v2_projection_provider_session_bindings',
            'orchestration_v2_thread_launch_workflows',
            'orchestration_v2_legacy_imports',
            'scheduled_tasks'
          )
        ORDER BY name
      `;
      assert.deepStrictEqual(
        tables.map(({ name }) => name),
        [
          "orchestration_v2_effect_outbox",
          "orchestration_v2_legacy_imports",
          "orchestration_v2_projection_metadata",
          "orchestration_v2_projection_provider_session_bindings",
          "orchestration_v2_projection_subagents",
          "orchestration_v2_projection_threads",
          "orchestration_v2_thread_launch_workflows",
          "orchestration_v2_turn_item_positions",
          "scheduled_tasks",
        ],
      );

      const eventColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(orchestration_events)
      `;
      const receiptColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(orchestration_command_receipts)
      `;
      const threadColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(orchestration_v2_projection_threads)
      `;
      const subagentColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(orchestration_v2_projection_subagents)
      `;
      assert.ok(eventColumns.some(({ name }) => name === "application_event_version"));
      assert.ok(receiptColumns.some(({ name }) => name === "command_type"));
      assert.ok(threadColumns.some(({ name }) => name === "provider_instance_id"));
      assert.ok(subagentColumns.some(({ name }) => name === "driver"));
      assert.ok(subagentColumns.some(({ name }) => name === "provider_instance_id"));

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND name IN (
            'idx_orchestration_events_application_high_water',
            'orchestration_events_v2_created_threads_idx',
            'orchestration_v2_projection_turn_items_shell_pending_idx'
          )
        ORDER BY name
      `;
      assert.deepStrictEqual(
        indexes.map(({ name }) => name),
        [
          "idx_orchestration_events_application_high_water",
          "orchestration_events_v2_created_threads_idx",
          "orchestration_v2_projection_turn_items_shell_pending_idx",
        ],
      );
    }),
  );

  it.effect("indexes sweep filters for existing threads and later payload-only writes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 60 });
      const payload = JSON.stringify({
        settledAt: "2026-07-24T00:00:00.000Z",
        settledOverride: "settled",
        pinnedAt: "2026-07-23T00:00:00.000Z",
        autoSettleDisabledAt: "2026-07-22T00:00:00.000Z",
        forkedFrom: { type: "run", threadId: "source-thread" },
        pullRequests: [{ number: 1 }, { number: 2 }],
      });
      yield* sql`
        INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, default_provider, provider_instance_id,
          runtime_mode, interaction_mode, created_at, updated_at, payload_json
        ) VALUES (
          'sweep-thread', 'sweep-project', 'Sweep thread', 'codex', 'codex',
          'full-access', 'default', '2026-07-24T00:00:00.000Z',
          '2026-07-24T00:00:00.000Z', ${payload}
        )
      `;
      yield* runMigrations();
      const sweep = sql<{ readonly thread_id: string; readonly pull_requests: number }>`
        SELECT thread_id, json_array_length(payload_json, '$.pullRequests') AS pull_requests
        FROM orchestration_v2_projection_threads
          INDEXED BY orchestration_v2_projection_threads_active_idx
        WHERE deleted_at IS NULL AND archived_at IS NULL
          AND json_extract(payload_json, '$.settledOverride') IS NULL
          AND json_extract(payload_json, '$.pinnedAt') = '2026-07-23T00:00:00.000Z'
          AND CASE
            WHEN json_extract(payload_json, '$.forkedFrom.type') = 'run'
              THEN json_extract(payload_json, '$.forkedFrom.threadId')
            ELSE NULL
          END = 'source-thread'
      `;
      assert.deepStrictEqual(yield* sweep, []);
      // An older build rewrites the payload alone; the index follows it.
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(
          json_remove(payload_json, '$.settledOverride'),
          '$.pullRequests',
          json('[{"number":1},{"number":2},{"number":3}]')
        )
        WHERE thread_id = 'sweep-thread'
      `;
      assert.deepStrictEqual(yield* sweep, [{ thread_id: "sweep-thread", pull_requests: 3 }]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  // Development builds of this change indexed copied columns under the same name.
  it.effect("replaces a same-named sweep index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 60 });
      yield* sql`
        CREATE INDEX orchestration_v2_projection_threads_active_idx
        ON orchestration_v2_projection_threads(updated_at, thread_id)
        WHERE deleted_at IS NULL AND archived_at IS NULL
      `;
      assert.deepStrictEqual(yield* runMigrations(), [[61, "ProjectionThreadSweepIndexes"]]);
      const [index] = yield* sql<{ readonly sql: string }>`
        SELECT sql FROM sqlite_master WHERE name = 'orchestration_v2_projection_threads_active_idx'
      `;
      assert.include(index!.sql, "json_extract(payload_json, '$.settledOverride')");
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  // Published previews ran PeerLinks as 61, so they never run this build's 61.
  it.effect("keeps sweeps correct on a preview database that ran PeerLinks as 61", () => {
    const skippedWarnings: Array<unknown> = [];
    const logger = Logger.make(({ fiber, logLevel }) => {
      const skipped = fiber.getRef(References.CurrentLogAnnotations).skipped;
      if (logLevel === "Warn" && skipped !== undefined) skippedWarnings.push(skipped);
    });
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 60 });
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (61, 'PeerLinks')`;
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(skippedWarnings, [["61_ProjectionThreadSweepIndexes"]]);
      assert.deepStrictEqual(
        yield* sql`
          SELECT name FROM sqlite_master
          WHERE name IN (
            'orchestration_v2_projection_threads_active_idx',
            'orchestration_v2_projection_runs_failed_idx'
          )
        `,
        [],
      );

      // Without the index, the pull request and usage-limit sweeps still find the thread.
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const at = DateTime.makeUnsafe("2026-10-01T00:00:00.000Z");
      const threadId = ThreadId.make("thread:peer-links");
      const runId = RunId.make("run:peer-links");
      const rootNodeId = NodeId.make("node:peer-links");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const modelSelection = { instanceId: providerInstanceId, model: "gpt-5.4" };
      const driver = ProviderDriverKind.make("codex");
      const thread = {
        createdBy: "user" as const,
        creationSource: "web" as const,
        id: threadId,
        projectId: ProjectId.make("project:peer-links"),
        title: "Preview thread",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: at,
        updatedAt: at,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      };
      yield* store.apply({
        id: EventId.make("event:peer-links:thread"),
        type: "thread.created",
        threadId,
        occurredAt: at,
        payload: thread,
      });
      yield* store.apply({
        id: EventId.make("event:peer-links:pull-request"),
        type: "thread.pull-request-synced",
        threadId,
        occurredAt: at,
        payload: {
          ...thread,
          pullRequests: [
            {
              host: "github.com",
              repository: "pingdotgg/t3code",
              number: 7,
              url: "https://github.com/pingdotgg/t3code/pull/7",
              source: "agent",
              linkedAt: DateTime.formatIso(at),
              snapshot: null,
              stack: null,
            },
          ],
        },
      });
      yield* store.apply({
        id: EventId.make("event:peer-links:run"),
        type: "run.created",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        providerInstanceId,
        occurredAt: at,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("message:peer-links"),
          rootNodeId,
          activeAttemptId: null,
          status: "failed",
          requestedAt: at,
          startedAt: at,
          completedAt: at,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* store.apply({
        id: EventId.make("event:peer-links:limit"),
        type: "turn-item.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: at,
        payload: {
          id: TurnItemId.make("item:peer-links:limit"),
          threadId,
          runId,
          nodeId: rootNodeId,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "failed",
          title: "Usage limit reached",
          startedAt: at,
          completedAt: at,
          updatedAt: at,
          type: "error",
          failure: {
            class: "usage_limit",
            message: "Plan limit reached.",
            resetAt: "2026-10-02T00:00:00.000Z",
            code: "usageLimitExceeded",
            retryable: null,
          },
        },
      });
      assert.deepStrictEqual(
        (yield* store.getThreadsWithPullRequests()).map((row) => row.id),
        [threadId],
      );
      assert.deepStrictEqual(
        (yield* store.getLimitRecoveryCandidates({ now: at, autoResume: true, snooze: false })).map(
          (row) => row.id,
        ),
        [threadId],
      );
    }).pipe(
      Effect.provide(
        ProjectionStore.layer.pipe(
          Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
          Layer.merge(Logger.layer([logger], { mergeWithExisting: false })),
        ),
      ),
    );
  });
});
