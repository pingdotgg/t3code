import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { layer as nodeSqliteClientLayer } from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as References from "effect/References";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import Migration0042 from "../persistence/Migrations/042_ProjectionThreadLinkedPullRequest.ts";
import Migration0043 from "../persistence/Migrations/043_ProjectionThreadsUnsettledAt.ts";
import Migration0044 from "../persistence/Migrations/044_ClearAutomaticProjectModelDefaults.ts";
import Migration0045 from "../persistence/Migrations/045_ProjectionProjectsAutoPull.ts";
import Migration0046 from "../persistence/Migrations/046_RepairAutomaticSettlementTimestamps.ts";
import Migration0047 from "../persistence/Migrations/047_ProjectionProjectIcon.ts";
import Migration0048 from "../persistence/Migrations/048_ProjectionThreadBranchPullRequest.ts";
import Migration0049 from "../persistence/Migrations/049_ProjectionThreadsActiveOrderKey.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { OrchestrationEffectWorkerV2 } from "./EffectWorker.ts";
import { layer as eventSinkLayer } from "./EventSink.ts";
import { layer as eventStoreLayer } from "./EventStore.ts";
import {
  LegacyV1ThreadImporter,
  layer as legacyV1ThreadImporterLayer,
} from "./LegacyV1ThreadImporter.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import {
  ProjectionMaintenanceV2,
  layer as projectionMaintenanceLayer,
} from "./ProjectionMaintenance.ts";
import { ProjectionStoreV2, layer as projectionStoreLayer } from "./ProjectionStore.ts";
import {
  ProviderAdapterProtocolError,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2Shape,
} from "./ProviderAdapter.ts";
import { makeSingleLayer } from "./ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";

const PROJECT_ID = "project:cutover";
const ACTIVE_THREAD = "thread:cutover:active";
const ARCHIVED_THREAD = "thread:cutover:archived";
const PINNED_THREAD = "thread:cutover:pinned";
const SNOOZED_THREAD = "thread:cutover:snoozed";
const DELETED_THREAD = "thread:cutover:deleted";
const INTERRUPTED_THREAD = "thread:cutover:interrupted";
const LONG_THREAD = "thread:cutover:long";
const ALL_THREADS = [
  ACTIVE_THREAD,
  ARCHIVED_THREAD,
  PINNED_THREAD,
  SNOOZED_THREAD,
  DELETED_THREAD,
  INTERRUPTED_THREAD,
  LONG_THREAD,
] as const;

const EARLIEST_MARKER = "EARLIEST_IMPORT_MARKER";
const LATEST_MARKER = "LATEST_IMPORT_MARKER";
const CONTINUATION_PROMPT = "Continue the migrated thread.";
const CONTINUATION_RESPONSE = "codex continuation response";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelectionJson = '{"instanceId":"codex","model":"gpt-5.4"}';
const codexModelSelection = {
  instanceId,
  model: "gpt-5.4",
};

/**
 * A V1 database as it exists on disk before a V2 server first opens it: schema
 * through migration 40 plus the 42-49 tail. Slot 41 carries a site-local
 * `ThreadSummaryTimeline` migration, matching production databases where local
 * builds recorded extra names under the shared id sequence. The V2 runner only
 * applies migrations past the recorded maximum id, so the cutover in this test
 * applies 050, 051 and 052 on top of the untouched copy — the same path the
 * real upgrade takes.
 */
const seedV1Database = (fixturePath: string, workspace: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA busy_timeout = 5000;`;
      yield* sql`PRAGMA foreign_keys = ON;`;
      yield* sql`PRAGMA journal_mode = WAL;`;
      yield* runMigrations({ toMigrationInclusive: 40 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (41, 'ThreadSummaryTimeline')
      `;
      yield* sql`
        CREATE TABLE thread_summary_timeline_entries (
          entry_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          payload_json TEXT NOT NULL
        )
      `;
      const tailMigrations = [
        [42, "ProjectionThreadLinkedPullRequest", Migration0042],
        [43, "ProjectionThreadsUnsettledAt", Migration0043],
        [44, "ClearAutomaticProjectModelDefaults", Migration0044],
        [45, "ProjectionProjectsAutoPull", Migration0045],
        [46, "RepairAutomaticSettlementTimestamps", Migration0046],
        [47, "ProjectionProjectIcon", Migration0047],
        [48, "ProjectionThreadBranchPullRequest", Migration0048],
        [49, "ProjectionThreadsActiveOrderKey", Migration0049],
      ] as const;
      for (const [id, name, migration] of tailMigrations) {
        yield* migration;
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (${id}, ${name})
        `;
      }

      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
        ) VALUES (
          ${PROJECT_ID},
          'Cutover project',
          ${workspace},
          '[]',
          '2026-01-01T00:00:00.000Z',
          '2026-01-10T00:00:00.000Z',
          NULL
        )
      `;

      const insertThread = (input: {
        readonly threadId: string;
        readonly title: string;
        readonly createdAt: string;
        readonly updatedAt: string;
        readonly archivedAt?: string;
        readonly snoozedAt?: string;
        readonly snoozedUntil?: string;
        readonly pinnedAt?: string;
        readonly pinOrderKey?: string;
        readonly deletedAt?: string;
        readonly worktreePath?: string;
        readonly linkedPullRequestJson?: string;
      }) =>
        sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode,
            interaction_mode, branch, worktree_path, latest_turn_id,
            created_at, updated_at, archived_at, settled_override, settled_at,
            unsettled_at, snoozed_until, snoozed_at, pinned_at, pin_order_key,
            linked_pull_request_json, deleted_at
          ) VALUES (
            ${input.threadId},
            ${PROJECT_ID},
            ${input.title},
            ${modelSelectionJson},
            'full-access',
            'default',
            'main',
            ${input.worktreePath ?? null},
            NULL,
            ${input.createdAt},
            ${input.updatedAt},
            ${input.archivedAt ?? null},
            NULL,
            NULL,
            NULL,
            ${input.snoozedUntil ?? null},
            ${input.snoozedAt ?? null},
            ${input.pinnedAt ?? null},
            ${input.pinOrderKey ?? null},
            ${input.linkedPullRequestJson ?? null},
            ${input.deletedAt ?? null}
          )
        `;

      const insertMessage = (input: {
        readonly messageId: string;
        readonly threadId: string;
        readonly role: "user" | "assistant";
        readonly text: string;
        readonly createdAt: string;
        readonly isStreaming?: boolean;
        readonly attachmentsJson?: string;
      }) =>
        sql`
          INSERT INTO projection_thread_messages (
            message_id, thread_id, turn_id, role, text, attachments_json,
            is_streaming, created_at, updated_at
          ) VALUES (
            ${input.messageId},
            ${input.threadId},
            NULL,
            ${input.role},
            ${input.text},
            ${input.attachmentsJson ?? "[]"},
            ${input.isStreaming === true ? 1 : 0},
            ${input.createdAt},
            ${input.createdAt}
          )
        `;

      yield* insertThread({
        threadId: ACTIVE_THREAD,
        title: "Active conversation",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-05T00:00:00.000Z",
        linkedPullRequestJson:
          '{"projectId":"project:cutover","repository":"pingdotgg/t3code","number":9100,"url":"https://github.com/pingdotgg/t3code/pull/9100"}',
      });
      yield* insertMessage({
        messageId: "message:cutover:active:1",
        threadId: ACTIVE_THREAD,
        role: "user",
        text: "First question",
        createdAt: "2026-01-01T01:00:00.000Z",
      });
      yield* insertMessage({
        messageId: "message:cutover:active:2",
        threadId: ACTIVE_THREAD,
        role: "assistant",
        text: "First answer",
        createdAt: "2026-01-02T01:00:00.000Z",
        attachmentsJson:
          '[{"type":"image","id":"att-1","name":"shot.png","mimeType":"image/png","sizeBytes":1234}]',
      });
      yield* insertMessage({
        messageId: "message:cutover:active:3",
        threadId: ACTIVE_THREAD,
        role: "user",
        text: "Follow-up question",
        createdAt: "2026-01-03T01:00:00.000Z",
      });
      yield* insertMessage({
        messageId: "message:cutover:active:4",
        threadId: ACTIVE_THREAD,
        role: "assistant",
        text: "Final answer",
        createdAt: "2026-01-05T01:00:00.000Z",
      });

      yield* insertThread({
        threadId: ARCHIVED_THREAD,
        title: "Archived conversation",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-06T00:00:00.000Z",
        archivedAt: "2026-01-06T00:00:00.000Z",
      });
      yield* insertMessage({
        messageId: "message:cutover:archived:1",
        threadId: ARCHIVED_THREAD,
        role: "user",
        text: "Archived question",
        createdAt: "2026-01-01T02:00:00.000Z",
      });
      yield* insertMessage({
        messageId: "message:cutover:archived:2",
        threadId: ARCHIVED_THREAD,
        role: "assistant",
        text: "Archived answer",
        createdAt: "2026-01-02T02:00:00.000Z",
      });

      yield* insertThread({
        threadId: PINNED_THREAD,
        title: "Pinned conversation",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-07T00:00:00.000Z",
        pinnedAt: "2026-01-03T00:00:00.000Z",
        pinOrderKey: "a0",
      });
      yield* insertMessage({
        messageId: "message:cutover:pinned:1",
        threadId: PINNED_THREAD,
        role: "user",
        text: "Pinned question",
        createdAt: "2026-01-01T03:00:00.000Z",
      });
      yield* insertMessage({
        messageId: "message:cutover:pinned:2",
        threadId: PINNED_THREAD,
        role: "assistant",
        text: "Pinned answer",
        createdAt: "2026-01-02T03:00:00.000Z",
      });

      yield* insertThread({
        threadId: SNOOZED_THREAD,
        title: "Snoozed conversation",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-08T00:00:00.000Z",
        snoozedAt: "2026-01-08T00:00:00.000Z",
        snoozedUntil: "2026-02-01T00:00:00.000Z",
      });
      yield* insertMessage({
        messageId: "message:cutover:snoozed:1",
        threadId: SNOOZED_THREAD,
        role: "user",
        text: "Snoozed question",
        createdAt: "2026-01-01T04:00:00.000Z",
      });
      yield* insertMessage({
        messageId: "message:cutover:snoozed:2",
        threadId: SNOOZED_THREAD,
        role: "assistant",
        text: "Snoozed answer part one",
        createdAt: "2026-01-02T04:00:00.000Z",
      });
      yield* insertMessage({
        messageId: "message:cutover:snoozed:3",
        threadId: SNOOZED_THREAD,
        role: "assistant",
        text: "Snoozed answer part two",
        createdAt: "2026-01-03T04:00:00.000Z",
      });

      yield* insertThread({
        threadId: DELETED_THREAD,
        title: "Deleted conversation",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-09T00:00:00.000Z",
        deletedAt: "2026-01-09T00:00:00.000Z",
      });
      yield* insertMessage({
        messageId: "message:cutover:deleted:1",
        threadId: DELETED_THREAD,
        role: "user",
        text: "Deleted question",
        createdAt: "2026-01-01T05:00:00.000Z",
      });
      yield* insertMessage({
        messageId: "message:cutover:deleted:2",
        threadId: DELETED_THREAD,
        role: "assistant",
        text: "Deleted answer",
        createdAt: "2026-01-02T05:00:00.000Z",
      });

      yield* insertThread({
        threadId: INTERRUPTED_THREAD,
        title: "Interrupted conversation",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-09T01:00:00.000Z",
      });
      yield* insertMessage({
        messageId: "message:cutover:interrupted:1",
        threadId: INTERRUPTED_THREAD,
        role: "user",
        text: "Interrupted question",
        createdAt: "2026-01-01T06:00:00.000Z",
      });
      yield* insertMessage({
        messageId: "message:cutover:interrupted:2",
        threadId: INTERRUPTED_THREAD,
        role: "assistant",
        text: "Partial answer",
        createdAt: "2026-01-02T06:00:00.000Z",
        isStreaming: true,
      });

      yield* insertThread({
        threadId: LONG_THREAD,
        title: "Long conversation",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-10T00:00:00.000Z",
        worktreePath: workspace,
      });
      const filler = "history detail ".repeat(800); // ~12k chars per message
      yield* insertMessage({
        messageId: "message:cutover:long:1",
        threadId: LONG_THREAD,
        role: "user",
        text: `${EARLIEST_MARKER} ${filler}`,
        createdAt: "2026-01-01T07:00:00.000Z",
      });
      yield* insertMessage({
        messageId: "message:cutover:long:2",
        threadId: LONG_THREAD,
        role: "assistant",
        text: `${filler} middle answer`,
        createdAt: "2026-01-02T07:00:00.000Z",
      });
      yield* insertMessage({
        messageId: "message:cutover:long:3",
        threadId: LONG_THREAD,
        role: "user",
        text: `${filler} middle question`,
        createdAt: "2026-01-03T07:00:00.000Z",
      });
      yield* insertMessage({
        messageId: "message:cutover:long:4",
        threadId: LONG_THREAD,
        role: "assistant",
        text: `${filler} ${LATEST_MARKER}`,
        createdAt: "2026-01-04T07:00:00.000Z",
      });

      yield* sql`PRAGMA wal_checkpoint(TRUNCATE);`;
    }).pipe(Effect.provide(nodeSqliteClientLayer({ filename: fixturePath }))),
  );

interface CapturedTurn {
  readonly threadId: ThreadId;
  readonly providerThreadId: ProviderThreadId;
  readonly text: string;
}

const unimplemented = (detail: string) =>
  Effect.fail(new ProviderAdapterProtocolError({ driver, detail }));

const makeCodexAdapter = (capturedTurns: Ref.Ref<ReadonlyArray<CapturedTurn>>) =>
  ({
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: sessionInput.providerSessionId,
          driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: sessionInput.runtimePolicy.cwd ?? process.cwd(),
          model: codexModelSelection.model,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        return {
          instanceId,
          driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession,
          events: Stream.fromPubSub(events),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              const nativeThreadId = `${driver}:${threadInput.threadId}`;
              return {
                id: ProviderThreadId.make(`provider-thread:${nativeThreadId}`),
                driver,
                providerInstanceId: instanceId,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: {
                  driver,
                  nativeId: nativeThreadId,
                  strength: "strong",
                },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              } satisfies OrchestrationV2ProviderThread;
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turnInput) =>
            Effect.gen(function* () {
              yield* Ref.update(capturedTurns, (turns) => [
                ...turns,
                {
                  threadId: turnInput.threadId,
                  providerThreadId: turnInput.providerThread.id,
                  text: turnInput.message.text,
                },
              ]);
              const eventTime = yield* DateTime.now;
              const providerTurnId = ProviderTurnId.make(
                `provider-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
              );
              yield* PubSub.publishAll(events, [
                {
                  type: "provider_turn.updated",
                  driver,
                  providerTurn: {
                    id: providerTurnId,
                    providerThreadId: turnInput.providerThread.id,
                    nodeId: turnInput.rootNodeId,
                    runAttemptId: turnInput.attemptId,
                    nativeTurnRef: {
                      driver,
                      nativeId: `native-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
                      strength: "strong",
                    },
                    ordinal: turnInput.runOrdinal,
                    status: "completed",
                    startedAt: eventTime,
                    completedAt: eventTime,
                  },
                },
                {
                  type: "turn_item.updated",
                  driver,
                  turnItem: {
                    id: TurnItemId.make(
                      `turn-item:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
                    ),
                    threadId: turnInput.threadId,
                    runId: turnInput.runId,
                    nodeId: turnInput.rootNodeId,
                    providerThreadId: turnInput.providerThread.id,
                    providerTurnId,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: turnInput.runOrdinal * 100 + 1,
                    status: "completed",
                    title: null,
                    startedAt: eventTime,
                    completedAt: eventTime,
                    updatedAt: eventTime,
                    type: "assistant_message",
                    messageId: MessageId.make(
                      `message:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
                    ),
                    text: CONTINUATION_RESPONSE,
                    streaming: false,
                  },
                },
                {
                  type: "turn.terminal",
                  driver,
                  providerThreadId: turnInput.providerThread.id,
                  providerTurnId,
                  runOrdinal: turnInput.runOrdinal,
                  status: "completed",
                  failure: null,
                  threadDisposition: "reusable",
                },
              ] satisfies ReadonlyArray<ProviderAdapterV2Event>);
            }),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => unimplemented("readThreadSnapshot unused in cutover test"),
          rollbackThread: () => unimplemented("rollbackThread unused in cutover test"),
          forkThread: () => unimplemented("forkThread unused in cutover test"),
        };
      }),
  }) satisfies ProviderAdapterV2Shape;

const waitForIdle = Effect.fn("LegacyV1Cutover.waitForIdle")(function* (threadId: ThreadId) {
  const orchestrator = yield* OrchestratorV2;
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const projection = yield* orchestrator.getThreadProjection(threadId);
    if (
      projection.runs.every(
        (run) => !["queued", "starting", "running", "waiting"].includes(run.status),
      )
    ) {
      return projection;
    }
    yield* Effect.sleep("5 millis");
  }
  return yield* Effect.die(new Error("Cutover test timed out waiting for idle"));
});

const makeBootLayer = (input: {
  readonly name: string;
  readonly dbPath: string;
  readonly workspace: string;
  readonly capturedTurns: Ref.Ref<ReadonlyArray<CapturedTurn>>;
}) => {
  const databaseLayer = makeSqlitePersistenceLive(input.dbPath).pipe(
    Layer.provide(NodeServices.layer),
  );
  const eventStoreProvided = eventStoreLayer.pipe(Layer.provideMerge(databaseLayer));
  const projectionStoreProvided = projectionStoreLayer.pipe(Layer.provideMerge(databaseLayer));
  const storesProvided = Layer.mergeAll(databaseLayer, eventStoreProvided, projectionStoreProvided);
  const eventSinkProvided = eventSinkLayer.pipe(Layer.provide(storesProvided));
  const importerProvided = legacyV1ThreadImporterLayer.pipe(
    Layer.provide(Layer.mergeAll(storesProvided, eventSinkProvided)),
  );
  const maintenanceProvided = projectionMaintenanceLayer.pipe(Layer.provide(storesProvided));
  const orchestratorProvided = makeOrchestratorV2ReplayLayerWithRegistry(
    {
      name: input.name,
      runtimePolicyOverride: {
        cwd: input.workspace,
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "readOnly",
          access: { type: "fullAccess" },
          networkAccess: false,
        },
      },
    },
    makeSingleLayer(makeCodexAdapter(input.capturedTurns)),
    { databaseLayer },
  );
  return Layer.mergeAll(
    storesProvided,
    eventSinkProvided,
    importerProvided,
    maintenanceProvided,
    orchestratorProvided,
  );
};

interface CapturedLog {
  readonly message: unknown;
  readonly annotations: Readonly<Record<string, unknown>>;
}

const makeCapturingLogger = (logs: CapturedLog[]) =>
  Logger.make(({ fiber, message }) => {
    logs.push({
      message,
      annotations: fiber.getRef(References.CurrentLogAnnotations),
    });
  });

const messageOrdinals = (projection: OrchestrationV2ThreadProjection) =>
  projection.turnItems
    .filter(
      (
        item,
      ): item is Extract<typeof item, { readonly type: "user_message" | "assistant_message" }> =>
        item.type === "user_message" || item.type === "assistant_message",
    )
    .map((item) => [String(item.messageId), item.ordinal, item.status] as const);

describe("orchestration v2 legacy v1 cutover", () => {
  it.live(
    "migrates an untouched v1 database copy through shell import, lazy transcripts, continuation and restart",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const workspace = yield* checkpointWorkspace("legacy-v1-cutover");
          const stateDir = yield* fs.makeTempDirectory({ prefix: "t3-v1-cutover-state-" });
          const fixturePath = path.join(stateDir, "v1-source.sqlite");
          const copyPath = path.join(stateDir, "userdata", "state.sqlite");
          yield* fs.makeDirectory(path.join(stateDir, "userdata"), { recursive: true });

          yield* seedV1Database(fixturePath, workspace);
          yield* fs.copyFile(fixturePath, copyPath);

          const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
          const longThreadId = ThreadId.make(LONG_THREAD);

          // First boot: the real file-backed stack migrates the copied database.
          const boot1Logs: CapturedLog[] = [];
          const firstBoot = yield* Effect.scoped(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              const importer = yield* LegacyV1ThreadImporter;
              const maintenance = yield* ProjectionMaintenanceV2;
              const projections = yield* ProjectionStoreV2;
              const orchestrator = yield* OrchestratorV2;

              assert.equal(yield* importer.pendingThreadCount, ALL_THREADS.length);
              const shellImport = yield* importer.reconcileShells;
              assert.deepStrictEqual(shellImport, {
                importedThreadCount: ALL_THREADS.length,
                importedMessageCount: 14,
              });
              // A repeated shell reconcile in the same boot is a no-op.
              assert.deepStrictEqual(yield* importer.reconcileShells, {
                importedThreadCount: 0,
                importedMessageCount: 0,
              });
              assert.isTrue((yield* maintenance.rebuild).valid);

              const shellSnapshot = yield* projections.getShellSnapshot();
              const visibleShellIds = [
                ...shellSnapshot.threads.map((thread) => thread.id),
                ...shellSnapshot.archivedThreads.map((thread) => thread.id),
              ];
              assert.notInclude(visibleShellIds, ThreadId.make(DELETED_THREAD));
              assert.include(
                shellSnapshot.archivedThreads.map((thread) => thread.id),
                ThreadId.make(ARCHIVED_THREAD),
              );
              const pinnedShell = shellSnapshot.threads.find(
                (thread) => thread.id === PINNED_THREAD,
              );
              assert.equal(pinnedShell?.pinOrderKey, "a0");

              // Shells carry only the last user + latest message previews until a
              // transcript is hydrated on demand.
              const activeShell = yield* projections.getThreadProjection(
                ThreadId.make(ACTIVE_THREAD),
              );
              assert.equal(activeShell.thread.historyOrigin, "v1_import");
              assert.isNull(activeShell.thread.activeProviderThreadId);
              assert.deepStrictEqual(
                activeShell.messages.map((message) => message.id),
                ["message:cutover:active:3", "message:cutover:active:4"],
              );
              assert.isEmpty(activeShell.providerThreads);
              // The import contract is messages + metadata only: no checkpoints,
              // tool items, or native sessions are presented as migrated.
              assert.isEmpty(
                activeShell.turnItems.filter(
                  (item) => item.type !== "user_message" && item.type !== "assistant_message",
                ),
              );

              const deletedShell = yield* projections.getThreadProjection(
                ThreadId.make(DELETED_THREAD),
              );
              assert.isNotNull(deletedShell.thread.deletedAt);
              assert.equal(
                deletedShell.thread.deletedAt?.toString(),
                DateTime.makeUnsafe("2026-01-09T00:00:00.000Z").toString(),
              );

              // Lazy transcript import on first read. The snoozed thread stays
              // unhydrated until after the restart to prove laziness survives a
              // process boundary.
              for (const threadId of [
                ACTIVE_THREAD,
                ARCHIVED_THREAD,
                PINNED_THREAD,
                DELETED_THREAD,
                INTERRUPTED_THREAD,
                LONG_THREAD,
              ]) {
                yield* importer.ensureTranscript(ThreadId.make(threadId));
              }
              assert.deepStrictEqual(
                yield* importer.ensureTranscript(ThreadId.make(ACTIVE_THREAD)),
                { importedThreadCount: 0, importedMessageCount: 0 },
              );

              const active = yield* projections.getThreadProjection(ThreadId.make(ACTIVE_THREAD));
              assert.deepStrictEqual(
                active.messages.map((message) => message.id),
                [
                  "message:cutover:active:1",
                  "message:cutover:active:2",
                  "message:cutover:active:3",
                  "message:cutover:active:4",
                ],
              );
              assert.deepStrictEqual(messageOrdinals(active), [
                ["message:cutover:active:1", 1, "completed"],
                ["message:cutover:active:2", 2, "completed"],
                ["message:cutover:active:3", 3, "completed"],
                ["message:cutover:active:4", 4, "completed"],
              ]);
              assert.deepStrictEqual(
                active.messages.find((message) => message.id === "message:cutover:active:2")
                  ?.attachments,
                [
                  {
                    type: "image",
                    id: "att-1",
                    name: "shot.png",
                    mimeType: "image/png",
                    sizeBytes: 1234,
                  },
                ],
              );
              assert.equal(active.thread.linkedPullRequest?.number, 9100);
              assert.deepStrictEqual(
                active.thread.pullRequests?.map((pullRequest) => pullRequest.number),
                [9100],
              );

              const archived = yield* projections.getThreadProjection(
                ThreadId.make(ARCHIVED_THREAD),
              );
              assert.isNotNull(archived.thread.archivedAt);
              const pinned = yield* projections.getThreadProjection(ThreadId.make(PINNED_THREAD));
              assert.isNotNull(pinned.thread.pinnedAt);
              assert.equal(pinned.thread.pinOrderKey, "a0");
              const snoozed = yield* projections.getThreadProjection(ThreadId.make(SNOOZED_THREAD));
              assert.equal(
                snoozed.thread.snoozedUntil?.toString(),
                DateTime.makeUnsafe("2026-02-01T00:00:00.000Z").toString(),
              );
              // Still preview-only: its transcript was never requested, so the
              // middle message between the two shell previews is absent.
              assert.deepStrictEqual(
                snoozed.messages.map((message) => message.id),
                ["message:cutover:snoozed:1", "message:cutover:snoozed:3"],
              );
              const snoozedImportRow = yield* sql<{
                readonly transcript_imported_at: string | null;
              }>`
              SELECT transcript_imported_at
              FROM orchestration_v2_legacy_imports
              WHERE thread_id = ${SNOOZED_THREAD}
            `;
              assert.isNull(snoozedImportRow[0]?.transcript_imported_at);

              const interrupted = yield* projections.getThreadProjection(
                ThreadId.make(INTERRUPTED_THREAD),
              );
              assert.deepStrictEqual(messageOrdinals(interrupted), [
                ["message:cutover:interrupted:1", 1, "completed"],
                ["message:cutover:interrupted:2", 2, "interrupted"],
              ]);

              // First continuation of a migrated thread: a fresh provider session
              // receives the newest transcript suffix inside the 32k handoff.
              yield* orchestrator.dispatch({
                type: "message.dispatch",
                createdBy: "user",
                creationSource: "web",
                commandId: CommandId.make("command:cutover:continue"),
                threadId: longThreadId,
                messageId: MessageId.make("message:cutover:long:continuation"),
                text: CONTINUATION_PROMPT,
                attachments: [],
                dispatchMode: { type: "start_immediately" },
              });
              const continued = yield* waitForIdle(longThreadId);

              const runs = continued.runs.filter((run) => run.ordinal >= 1);
              assert.equal(runs.at(-1)?.status, "completed");
              assert.equal(continued.providerThreads.length, 1);
              assert.isNotNull(continued.providerThreads[0]?.nativeThreadRef);
              assert.equal(continued.contextHandoffs.length, 1);
              const handoff = continued.contextHandoffs[0]!;
              assert.equal(handoff.strategy, "manual_context");
              assert.isAtMost(handoff.summaryText.length, 32_000);
              assert.include(handoff.summaryText, LATEST_MARKER);
              assert.notInclude(handoff.summaryText, EARLIEST_MARKER);
              const turns = yield* Ref.get(capturedTurns);
              assert.equal(turns.length, 1);
              assert.include(turns[0]!.text, "Context handoff (manual_context):");
              assert.include(turns[0]!.text, `User message:\n${CONTINUATION_PROMPT}`);

              // The next continuation reuses the provider thread without a new
              // handoff: the imported context is only reissued until a v2 run
              // completes.
              yield* orchestrator.dispatch({
                type: "message.dispatch",
                createdBy: "user",
                creationSource: "web",
                commandId: CommandId.make("command:cutover:continue:again"),
                threadId: longThreadId,
                messageId: MessageId.make("message:cutover:long:continuation:2"),
                text: "One more.",
                attachments: [],
                dispatchMode: { type: "start_immediately" },
              });
              const continuedAgain = yield* waitForIdle(longThreadId);
              assert.equal(continuedAgain.contextHandoffs.length, 1);
              assert.equal((yield* Ref.get(capturedTurns)).length, 2);

              // Drain the outbox worker so the persisted event count is settled
              // before the restart boot re-reads it.
              const worker = yield* OrchestrationEffectWorkerV2;
              yield* worker.drain();

              const migrationEventCount = yield* sql<{ readonly count: number }>`
              SELECT COUNT(*) AS count
              FROM orchestration_events
              WHERE application_event_version = 2
                AND event_id LIKE 'migration:v1:%'
            `;
              const importRows = yield* sql<{
                readonly thread_id: string;
                readonly transcript_imported_at: string | null;
              }>`
              SELECT thread_id, transcript_imported_at
              FROM orchestration_v2_legacy_imports
              ORDER BY thread_id
            `;
              const legacyMessageCount = yield* sql<{ readonly count: number }>`
              SELECT COUNT(*) AS count FROM projection_thread_messages
            `;
              const legacyThreadCount = yield* sql<{ readonly count: number }>`
              SELECT COUNT(*) AS count FROM projection_threads
            `;
              const recordedMigration41 = yield* sql<{ readonly name: string }>`
              SELECT name FROM effect_sql_migrations WHERE migration_id = 41
            `;
              const authSessionColumns = yield* sql<{ readonly name: string }>`
              PRAGMA table_info(auth_sessions)
            `;
              return {
                migrationEventCount: migrationEventCount[0]?.count ?? 0,
                importRows,
                legacyMessageCount: legacyMessageCount[0]?.count ?? 0,
                legacyThreadCount: legacyThreadCount[0]?.count ?? 0,
                longProjection: continuedAgain,
                migration41Name: recordedMigration41[0]?.name ?? null,
                authSessionColumnNames: authSessionColumns.map((column) => column.name),
              };
            }).pipe(
              Effect.provide(
                makeBootLayer({
                  name: "legacy-v1-cutover-first",
                  dbPath: copyPath,
                  workspace,
                  capturedTurns,
                }),
              ),
              Effect.provideService(
                Logger.CurrentLoggers,
                new Set([makeCapturingLogger(boot1Logs)]),
              ),
            ),
          );

          // The copied database recorded a site-local migration under id 41, so
          // the migrator skipped this build's AuthSessionClientConnection by
          // id. The divergence is surfaced at startup while the rest of the
          // cutover still runs.
          const divergenceLog = boot1Logs.find((log) =>
            String(log.message).includes("migration history diverges"),
          );
          assert.deepStrictEqual(divergenceLog?.annotations.divergent, [
            "41:ThreadSummaryTimeline (this build: AuthSessionClientConnection)",
          ]);
          assert.equal(firstBoot.migration41Name, "ThreadSummaryTimeline");
          // The skipped migration's columns never landed; the schema gap is
          // what the startup warning points at.
          assert.notInclude(firstBoot.authSessionColumnNames, "client_surface");
          assert.notInclude(firstBoot.authSessionColumnNames, "client_app_version");

          assert.equal(firstBoot.importRows.length, ALL_THREADS.length);
          const unhydratedRows = firstBoot.importRows.filter(
            (row) => row.transcript_imported_at === null,
          );
          assert.deepStrictEqual(
            unhydratedRows.map((row) => row.thread_id),
            [SNOOZED_THREAD],
          );

          // Restart: a fresh runtime on the same file repeats nothing, and the
          // still-unhydrated snoozed transcript lands lazily after the restart.
          const boot2Logs: CapturedLog[] = [];
          yield* Effect.scoped(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              const importer = yield* LegacyV1ThreadImporter;
              const projections = yield* ProjectionStoreV2;

              assert.equal(yield* importer.pendingThreadCount, 1);
              assert.deepStrictEqual(yield* importer.reconcileShells, {
                importedThreadCount: 0,
                importedMessageCount: 0,
              });
              assert.deepStrictEqual(
                yield* importer.ensureTranscript(ThreadId.make(SNOOZED_THREAD)),
                { importedThreadCount: 1, importedMessageCount: 1 },
              );
              const snoozed = yield* projections.getThreadProjection(ThreadId.make(SNOOZED_THREAD));
              assert.deepStrictEqual(
                snoozed.messages.map((message) => message.id),
                [
                  "message:cutover:snoozed:1",
                  "message:cutover:snoozed:2",
                  "message:cutover:snoozed:3",
                ],
              );
              assert.equal(yield* importer.pendingThreadCount, 0);
              for (const threadId of ALL_THREADS) {
                assert.deepStrictEqual(yield* importer.ensureTranscript(ThreadId.make(threadId)), {
                  importedThreadCount: 0,
                  importedMessageCount: 0,
                });
              }
              const migrationEventCount = yield* sql<{ readonly count: number }>`
              SELECT COUNT(*) AS count
              FROM orchestration_events
              WHERE application_event_version = 2
                AND event_id LIKE 'migration:v1:%'
            `;
              // The snoozed transcript hydration above appends its own two
              // migration events (message + turn item); nothing else repeats.
              assert.equal(migrationEventCount[0]?.count, firstBoot.migrationEventCount + 2);

              const restarted = yield* projections.getThreadProjection(longThreadId);
              assert.equal(restarted.thread.historyOrigin, "v1_import");
              assert.equal(restarted.contextHandoffs.length, 1);
              assert.isNotNull(restarted.thread.activeProviderThreadId);
              assert.deepStrictEqual(
                restarted.runs.map((run) => run.status),
                firstBoot.longProjection.runs.map((run) => run.status),
              );

              // The v1 projection tables remain the untouched, read-only
              // recovery source after migration and restart.
              const legacyMessageCount = yield* sql<{ readonly count: number }>`
              SELECT COUNT(*) AS count FROM projection_thread_messages
            `;
              const legacyThreadCount = yield* sql<{ readonly count: number }>`
              SELECT COUNT(*) AS count FROM projection_threads
            `;
              assert.equal(legacyMessageCount[0]?.count, firstBoot.legacyMessageCount);
              assert.equal(legacyThreadCount[0]?.count, firstBoot.legacyThreadCount);
              const quickCheck = yield* sql<{ readonly quick_check: string }>`
              PRAGMA quick_check
            `;
              assert.deepStrictEqual(
                quickCheck.map((row) => row.quick_check),
                ["ok"],
              );
            }).pipe(
              Effect.provide(
                makeBootLayer({
                  name: "legacy-v1-cutover-restart",
                  dbPath: copyPath,
                  workspace,
                  capturedTurns,
                }),
              ),
              Effect.provideService(
                Logger.CurrentLoggers,
                new Set([makeCapturingLogger(boot2Logs)]),
              ),
            ),
          );

          // The recorded-name divergence persists across restarts; the warning
          // fires again so it cannot be missed between upgrades.
          assert.isTrue(
            boot2Logs.some((log) => String(log.message).includes("migration history diverges")),
          );
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
  );
});
