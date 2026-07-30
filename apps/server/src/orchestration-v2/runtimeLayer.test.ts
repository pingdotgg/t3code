import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type ApplicationStoredEvent,
  CommandId,
  ContextTransferId,
  EventId,
  MessageId,
  type ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { ServerConfig } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import { ProjectEnrichmentService } from "../project/ProjectEnrichmentService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { layer as mcpSessionRegistryTestLayer } from "../mcp/McpSessionRegistry.testkit.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { LegacyV1ThreadImporter, LegacyV1ThreadImportError } from "./LegacyV1ThreadImporter.ts";
import {
  OrchestratorDispatchError,
  OrchestratorProjectionError,
  OrchestratorV2,
} from "./Orchestrator.ts";
import { OrchestrationEffectWorkerV2 } from "./EffectWorker.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { ProjectionMaintenanceV2 } from "./ProjectionMaintenance.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import { OrchestrationV2EventSinkLayerLive, OrchestrationV2LayerLive } from "./runtimeLayer.ts";
import { shellStreamItemFromThreadShell } from "./ShellStream.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { ThreadManagementService } from "./ThreadManagementService.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-orchestration-v2-runtime-layer-",
});

const GitCoreTestLayer = GitCoreLive.pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provide(NodeServices.layer),
);

const CheckpointStoreTestLayer = CheckpointStore.layer.pipe(
  Layer.provide(VcsDriverRegistryTestLayer),
);

const driver = ProviderDriverKind.make("codex");
const orchestrationAdapter = {
  instanceId: modelSelection.instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("sessions are not used by lifecycle tests"),
} as ProviderAdapterV2Shape;
const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: {
    driverKind: driver,
    continuationKey: "codex:test",
  },
  displayName: "Codex test",
  enabled: true,
  snapshot: {} as ProviderInstance["snapshot"],
  orchestrationAdapter,
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const TestProviderInstanceRegistry = Layer.succeed(ProviderInstanceRegistry, {
  getInstance: (instanceId) =>
    Effect.succeed(instanceId === providerInstance.instanceId ? providerInstance : undefined),
  listInstances: Effect.succeed([providerInstance]),
  listUnavailable: Effect.succeed([]),
  streamChanges: Stream.empty,
  subscribeChanges: Effect.never,
});

const TestLayer = Layer.merge(OrchestrationV2LayerLive, OrchestrationV2EventSinkLayerLive).pipe(
  Layer.provide(mcpSessionRegistryTestLayer),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(CheckpointStoreTestLayer),
  Layer.provide(ServerConfigLayer),
  Layer.provide(ServerSettingsService.layerTest()),
  Layer.provide(TestProviderInstanceRegistry),
  Layer.provide(NodeServices.layer),
);

const LegacyImportTestLayer = OrchestrationV2LayerLive.pipe(
  Layer.provide(mcpSessionRegistryTestLayer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(CheckpointStoreTestLayer),
  Layer.provide(ServerConfigLayer),
  Layer.provide(ServerSettingsService.layerTest()),
  Layer.provide(TestProviderInstanceRegistry),
  Layer.provide(NodeServices.layer),
);

const SharedApplicationDataPlaneTestLayer = Layer.merge(
  OrchestrationLayerLive,
  OrchestrationV2LayerLive,
).pipe(
  Layer.provide(
    Layer.succeed(ProjectEnrichmentService, {
      peek: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      request: () => Effect.void,
      getAvailable: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      invalidate: () => Effect.void,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(mcpSessionRegistryTestLayer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(CheckpointStoreTestLayer),
  Layer.provide(ServerConfigLayer),
  Layer.provide(ServerSettingsService.layerTest()),
  Layer.provide(TestProviderInstanceRegistry),
  Layer.provide(NodeServices.layer),
);

it.layer(TestLayer)("OrchestrationV2LayerLive", (it) => {
  it.effect("creates and reads a thread through the production V2 composition", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const threadId = ThreadId.make("runtime-layer-thread");
      const projectId = ProjectId.make("runtime-layer-project");

      const result = yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-create"),
        threadId,
        projectId,
        title: "Runtime layer thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5.4",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });

      const projection = yield* orchestrator.getThreadProjection(threadId);

      assert.equal(result.sequence, 1);
      assert.equal(projection.thread.id, threadId);
      assert.equal(projection.thread.projectId, projectId);
      assert.equal(projection.thread.providerInstanceId, "codex");
      assert.deepEqual(projection.runs, []);
    }),
  );

  it.effect("merges an explicit provider-finished run while checkpoint capture is pending", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const eventSink = yield* EventSinkV2;
      const now = yield* DateTime.now;
      const projectId = ProjectId.make("runtime-layer-waiting-merge-project");
      const targetThreadId = ThreadId.make("runtime-layer-waiting-merge-target");
      const sourceThreadId = ThreadId.make("runtime-layer-waiting-merge-source");
      const baseRunId = RunId.make("runtime-layer-waiting-merge-base-run");
      const sourceRunId = RunId.make("runtime-layer-waiting-merge-source-run");
      const sourceProviderThreadId = ProviderThreadId.make(
        "runtime-layer-waiting-merge-provider-thread",
      );
      const forkTransferId = ContextTransferId.make("runtime-layer-waiting-merge-fork-transfer");

      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-waiting-merge-create-target"),
        threadId: targetThreadId,
        projectId,
        title: "Waiting merge target",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const target = yield* orchestrator.getThreadProjection(targetThreadId);

      yield* eventSink.write({
        commandId: CommandId.make("runtime-layer-waiting-merge-seed"),
        events: [
          {
            id: EventId.make("runtime-layer-waiting-merge-source-thread-event"),
            type: "thread.created",
            threadId: sourceThreadId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: {
              ...target.thread,
              id: sourceThreadId,
              title: "Waiting merge source",
              activeProviderThreadId: null,
              lineage: {
                parentThreadId: targetThreadId,
                relationshipToParent: "fork",
                rootThreadId: targetThreadId,
              },
              forkedFrom: {
                type: "run",
                threadId: targetThreadId,
                runId: baseRunId,
              },
              createdAt: now,
              updatedAt: now,
            },
          },
          {
            id: EventId.make("runtime-layer-waiting-merge-fork-transfer-event"),
            type: "context-transfer.created",
            threadId: sourceThreadId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: {
              id: forkTransferId,
              type: "fork",
              sourceThreadId: targetThreadId,
              targetThreadId: sourceThreadId,
              sourcePoint: { threadId: targetThreadId, runId: baseRunId },
              basePoint: null,
              sourceProviderInstanceId: modelSelection.instanceId,
              targetProviderInstanceId: modelSelection.instanceId,
              targetRunId: null,
              status: "consumed",
              resolution: null,
              createdBy: "user",
              error: null,
              createdAt: now,
              updatedAt: now,
              consumedAt: now,
            },
          },
          {
            id: EventId.make("runtime-layer-waiting-merge-provider-thread-event"),
            type: "provider-thread.updated",
            threadId: sourceThreadId,
            driver,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: {
              id: sourceProviderThreadId,
              driver,
              providerInstanceId: modelSelection.instanceId,
              providerSessionId: null,
              appThreadId: sourceThreadId,
              ownerNodeId: null,
              nativeThreadRef: {
                driver,
                nativeId: "native-waiting-merge-source",
                strength: "strong",
              },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: 1,
              lastRunOrdinal: 1,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            },
          },
          {
            id: EventId.make("runtime-layer-waiting-merge-source-run-event"),
            type: "run.created",
            threadId: sourceThreadId,
            runId: sourceRunId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: {
              id: sourceRunId,
              threadId: sourceThreadId,
              ordinal: 1,
              providerInstanceId: modelSelection.instanceId,
              modelSelection,
              providerThreadId: sourceProviderThreadId,
              userMessageId: MessageId.make("runtime-layer-waiting-merge-message"),
              rootNodeId: null,
              activeAttemptId: null,
              status: "waiting",
              queuePosition: null,
              requestedAt: now,
              startedAt: now,
              completedAt: null,
              checkpointId: null,
              contextHandoffId: null,
            },
          },
        ],
      });

      yield* orchestrator.dispatch({
        type: "thread.merge_back",
        createdBy: "user",
        creationSource: "mobile",
        commandId: CommandId.make("runtime-layer-waiting-merge"),
        sourceThreadId,
        targetThreadId,
        sourcePoint: { type: "run", runId: sourceRunId },
        createdAt: now,
      });

      const mergedTarget = yield* orchestrator.getThreadProjection(targetThreadId);
      const transfer = mergedTarget.contextTransfers.find(
        (candidate) => candidate.type === "merge_back",
      );
      assert.isDefined(transfer);
      assert.equal(transfer.status, "pending");
      assert.equal(transfer.sourceThreadId, sourceThreadId);
      assert.equal(transfer.targetThreadId, targetThreadId);
      assert.equal(transfer.sourcePoint.runId, sourceRunId);
      assert.isUndefined(transfer.sourcePoint.checkpointId);
      assert.equal(transfer.sourcePoint.providerThreadRef?.nativeId, "native-waiting-merge-source");
      assert.equal(transfer.basePoint?.runId, baseRunId);
      assert.isNull(transfer.error);
    }),
  );
});

it.layer(LegacyImportTestLayer)("OrchestrationV2 legacy import", (it) => {
  it.effect("hydrates imported transcripts before commands and propagates hydration failures", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* LegacyV1ThreadImporter;
      const maintenance = yield* ProjectionMaintenanceV2;
      const orchestrator = yield* OrchestratorV2;
      const threadManagement = yield* ThreadManagementService;
      const metadataThreadId = ThreadId.make("runtime-layer-legacy-metadata-thread");
      const failureThreadId = ThreadId.make("runtime-layer-legacy-failure-thread");
      const projectId = ProjectId.make("runtime-layer-legacy-project");

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        ) VALUES (
          ${projectId},
          'Legacy project',
          '/tmp/runtime-layer-legacy-project',
          '{"instanceId":"codex","model":"gpt-5.4"}',
          '[]',
          '2026-01-01T00:00:00.000Z',
          '2026-01-04T00:00:00.000Z',
          NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          settled_override,
          settled_at,
          deleted_at
        ) VALUES
          (
            ${metadataThreadId},
            ${projectId},
            'Legacy metadata title',
            '{"instanceId":"codex","model":"gpt-5.4"}',
            'full-access',
            'default',
            'main',
            '/tmp/runtime-layer-legacy-project',
            NULL,
            '2026-01-01T00:00:00.000Z',
            '2026-01-04T00:00:00.000Z',
            NULL,
            NULL,
            NULL,
            NULL
          ),
          (
            ${failureThreadId},
            ${projectId},
            'Legacy failure title',
            '{"instanceId":"codex","model":"gpt-5.4"}',
            'full-access',
            'default',
            'main',
            '/tmp/runtime-layer-legacy-project',
            NULL,
            '2026-01-01T00:00:00.000Z',
            '2026-01-04T00:00:00.000Z',
            NULL,
            NULL,
            NULL,
            NULL
          )
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          attachments_json,
          is_streaming,
          created_at,
          updated_at
        ) VALUES
          (
            'message:runtime-layer-legacy:1',
            ${metadataThreadId},
            NULL,
            'user',
            'First imported question',
            '[]',
            0,
            '2026-01-01T01:00:00.000Z',
            '2026-01-01T01:00:00.000Z'
          ),
          (
            'message:runtime-layer-legacy:2',
            ${metadataThreadId},
            NULL,
            'assistant',
            'First imported answer',
            '[]',
            0,
            '2026-01-02T01:00:00.000Z',
            '2026-01-02T01:00:00.000Z'
          ),
          (
            'message:runtime-layer-legacy:3',
            ${metadataThreadId},
            NULL,
            'user',
            'Latest imported question',
            '[]',
            0,
            '2026-01-03T01:00:00.000Z',
            '2026-01-03T01:00:00.000Z'
          ),
          (
            'message:runtime-layer-legacy:failure',
            ${failureThreadId},
            NULL,
            'user',
            'Imported context must load before archive',
            '[]',
            0,
            '2026-01-03T01:00:00.000Z',
            '2026-01-03T01:00:00.000Z'
          )
      `;

      yield* importer.reconcileShells;
      const rebuilt = yield* maintenance.rebuild;
      assert.isTrue(rebuilt.valid);

      yield* threadManagement.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("runtime-layer-legacy-metadata-update"),
        threadId: metadataThreadId,
        title: "Updated after import",
      });
      const updatedProjection = yield* threadManagement.getThreadProjection(metadataThreadId);
      assert.equal(updatedProjection.thread.title, "Updated after import");
      assert.deepEqual(
        updatedProjection.messages.map((message) => message.text),
        ["First imported question", "First imported answer", "Latest imported question"],
      );

      yield* sql`
        ALTER TABLE projection_thread_messages
        RENAME TO projection_thread_messages_unavailable
      `;
      const { projectionFailure, hydrationFailure } = yield* Effect.all({
        projectionFailure: threadManagement.getThreadProjection(failureThreadId).pipe(Effect.flip),
        hydrationFailure: threadManagement
          .dispatch({
            type: "thread.archive",
            commandId: CommandId.make("runtime-layer-legacy-failed-archive"),
            threadId: failureThreadId,
          })
          .pipe(Effect.flip),
      }).pipe(
        Effect.ensuring(
          sql`
            ALTER TABLE projection_thread_messages_unavailable
            RENAME TO projection_thread_messages
          `.pipe(Effect.orDie),
        ),
      );
      assert.instanceOf(projectionFailure, OrchestratorProjectionError);
      assert.instanceOf(projectionFailure.cause, LegacyV1ThreadImportError);
      assert.instanceOf(hydrationFailure, OrchestratorDispatchError);
      assert.instanceOf(hydrationFailure.cause, LegacyV1ThreadImportError);

      const projectionAfterFailure = yield* orchestrator.getThreadProjection(failureThreadId);
      assert.isNull(projectionAfterFailure.thread.archivedAt);

      yield* threadManagement.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("runtime-layer-legacy-retried-archive"),
        threadId: failureThreadId,
      });
      const projectionAfterRetry = yield* threadManagement.getThreadProjection(failureThreadId);
      assert.isNotNull(projectionAfterRetry.thread.archivedAt);
    }),
  );
});

it.layer(TestLayer)("OrchestrationV2LayerLive lifecycle", (it) => {
  it.effect("applies lifecycle commands idempotently and emits archive/removal shell deltas", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const threadId = ThreadId.make("runtime-layer-lifecycle-thread");
      const create = {
        type: "thread.create" as const,
        createdBy: "user" as const,
        creationSource: "web" as const,
        commandId: CommandId.make("runtime-layer-lifecycle-create"),
        threadId,
        projectId: ProjectId.make("runtime-layer-lifecycle-project"),
        title: "Lifecycle thread",
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
      };

      const firstCreate = yield* orchestrator.dispatch(create);
      const retriedCreate = yield* orchestrator.dispatch(create);
      assert.equal(retriedCreate.sequence, firstCreate.sequence);
      assert.lengthOf(retriedCreate.storedEvents, 1);

      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("runtime-layer-lifecycle-metadata"),
        threadId,
        title: "Renamed lifecycle thread",
        branch: "feature/v2",
        worktreePath: "/tmp/t3-v2-worktree",
      });
      const staleWorkspaceUpdate = yield* orchestrator
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("runtime-layer-lifecycle-stale-workspace"),
          threadId,
          branch: "feature/stale",
          worktreePath: "/tmp/stale-worktree",
          expectedWorktreePath: null,
        })
        .pipe(Effect.flip);
      assert.instanceOf(staleWorkspaceUpdate, OrchestratorDispatchError);
      const projectionAfterStaleWorkspaceUpdate = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(projectionAfterStaleWorkspaceUpdate.thread.branch, "feature/v2");
      assert.equal(projectionAfterStaleWorkspaceUpdate.thread.worktreePath, "/tmp/t3-v2-worktree");
      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("runtime-layer-lifecycle-runtime"),
        threadId,
        runtimeMode: "approval-required",
      });
      yield* orchestrator.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.make("runtime-layer-lifecycle-interaction"),
        threadId,
        interactionMode: "plan",
      });
      yield* orchestrator.dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make("runtime-layer-lifecycle-model"),
        threadId,
        modelSelection: { ...modelSelection, model: "gpt-5.5" },
      });

      const archive = yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("runtime-layer-lifecycle-archive"),
        threadId,
      });
      const archivedShell = yield* orchestrator.getShellSnapshot();
      assert.notInclude(
        archivedShell.threads.map((thread) => thread.id),
        threadId,
      );
      assert.include(
        archivedShell.archivedThreads.map((thread) => thread.id),
        threadId,
      );
      assert.deepEqual(
        shellStreamItemFromThreadShell({
          stored: archive.storedEvents[0]!,
          shell: yield* orchestrator.getThreadShell(threadId),
        }),
        {
          kind: "thread.updated",
          sequence: archive.sequence,
          location: "archive",
          thread: archivedShell.archivedThreads[0]!,
        },
      );

      const remove = yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("runtime-layer-lifecycle-delete"),
        threadId,
      });
      const deletedShell = yield* orchestrator.getShellSnapshot();
      assert.notInclude(
        deletedShell.threads.map((thread) => thread.id),
        threadId,
      );
      assert.notInclude(
        deletedShell.archivedThreads.map((thread) => thread.id),
        threadId,
      );
      assert.deepEqual(
        shellStreamItemFromThreadShell({
          stored: remove.storedEvents[0]!,
          shell: yield* orchestrator.getThreadShell(threadId),
        }),
        {
          kind: "thread.removed",
          sequence: remove.sequence,
          location: "archive",
          threadId,
        },
      );

      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(projection.thread.title, "Renamed lifecycle thread");
      assert.equal(projection.thread.branch, "feature/v2");
      assert.equal(projection.thread.worktreePath, "/tmp/t3-v2-worktree");
      assert.equal(projection.thread.runtimeMode, "approval-required");
      assert.equal(projection.thread.interactionMode, "plan");
      assert.equal(projection.thread.modelSelection.model, "gpt-5.5");
      assert.isNotNull(projection.thread.archivedAt);
      assert.isNotNull(projection.thread.deletedAt);
    }),
  );

  it.effect("persists rejected command receipts across retries", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const command = {
        type: "thread.archive" as const,
        commandId: CommandId.make("runtime-layer-rejected-command"),
        threadId: ThreadId.make("runtime-layer-missing-thread"),
      };

      const first = yield* orchestrator.dispatch(command).pipe(Effect.flip);
      const retry = yield* orchestrator.dispatch(command).pipe(Effect.flip);

      assert.equal(first._tag, "OrchestratorProjectionError");
      assert.equal(retry._tag, "OrchestratorCommandPreviouslyRejectedError");
    }),
  );

  it.effect("rejects settling a thread while a run is active", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const threadId = ThreadId.make("runtime-layer-active-settle-thread");

      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-active-settle-create"),
        threadId,
        projectId: ProjectId.make("runtime-layer-active-settle-project"),
        title: "Active settle",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: "/tmp/runtime-layer-active-settle",
      });
      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("runtime-layer-active-settle-initial"),
        threadId,
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-active-settle-message"),
        threadId,
        messageId: MessageId.make("runtime-layer-active-settle-message"),
        text: "Keep this run active.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });

      const error = yield* orchestrator
        .dispatch({
          type: "thread.settle",
          commandId: CommandId.make("runtime-layer-active-settle"),
          threadId,
        })
        .pipe(Effect.flip);

      assert.equal(error._tag, "OrchestratorDispatchError");
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(projection.runs[0]?.status, "starting");
      assert.isNull(projection.thread.settledOverride);
      assert.isNull(projection.thread.settledAt);
    }),
  );

  it.effect("cancels queued work when a thread is archived", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const threadId = ThreadId.make("runtime-layer-archive-queued-thread");

      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-archive-queued-create"),
        threadId,
        projectId: ProjectId.make("runtime-layer-archive-queued-project"),
        title: "Archive queued work",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: "/tmp/runtime-layer-archive-queued",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-archive-queued-active-message"),
        threadId,
        messageId: MessageId.make("runtime-layer-archive-queued-active-message"),
        text: "Keep the provider occupied.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-archive-queued-next-message"),
        threadId,
        messageId: MessageId.make("runtime-layer-archive-queued-next-message"),
        text: "Do not run this after archive.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "queue_after_active" },
      });

      const beforeArchive = yield* orchestrator.getThreadProjection(threadId);
      const activeRun = beforeArchive.runs.find((run) => run.status === "starting");
      const queuedRun = beforeArchive.runs.find((run) => run.status === "queued");
      assert.isDefined(activeRun);
      assert.isDefined(queuedRun);

      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("runtime-layer-archive-queued-archive"),
        threadId,
      });

      const archived = yield* orchestrator.getThreadProjection(threadId);
      assert.isNotNull(archived.thread.archivedAt);
      assert.equal(archived.runs.find((run) => run.id === queuedRun.id)?.status, "cancelled");
      assert.equal(
        archived.attempts.find((attempt) => attempt.runId === queuedRun.id)?.status,
        "cancelled",
      );
      assert.equal(archived.nodes.find((node) => node.runId === queuedRun.id)?.status, "cancelled");
      assert.equal(yield* orchestrator.resumeQueuedRuns, 0);

      const promoteError = yield* orchestrator
        .dispatch({
          type: "queued-message.promote-to-steer",
          commandId: CommandId.make("runtime-layer-archive-queued-promote"),
          threadId,
          queuedRunId: queuedRun.id,
          targetRunId: activeRun.id,
        })
        .pipe(Effect.flip);
      assert.equal(promoteError._tag, "OrchestratorDispatchError");

      const afterPromotion = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(afterPromotion.runs.find((run) => run.id === queuedRun.id)?.status, "cancelled");
    }),
  );

  it.effect("promotes only one queued run after each terminal run", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const eventSink = yield* EventSinkV2;
      const threadId = ThreadId.make("runtime-layer-serialized-queue-thread");

      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-serialized-queue-create"),
        threadId,
        projectId: ProjectId.make("runtime-layer-serialized-queue-project"),
        title: "Serialized queue",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-serialized-queue-active"),
        threadId,
        messageId: MessageId.make("runtime-layer-serialized-queue-active"),
        text: "Active",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-serialized-queue-first"),
        threadId,
        messageId: MessageId.make("runtime-layer-serialized-queue-first"),
        text: "First queued",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "queue_after_active" },
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-serialized-queue-second"),
        threadId,
        messageId: MessageId.make("runtime-layer-serialized-queue-second"),
        text: "Second queued",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "queue_after_active" },
      });

      const before = yield* orchestrator.getThreadProjection(threadId);
      const activeRun = before.runs.find((run) => run.status === "starting");
      const queuedRuns = before.runs
        .filter((run) => run.status === "queued")
        .toSorted((left, right) => left.ordinal - right.ordinal);
      const firstQueuedRun = queuedRuns[0];
      const secondQueuedRun = queuedRuns[1];
      assert.isDefined(activeRun);
      assert.isDefined(firstQueuedRun);
      assert.isDefined(secondQueuedRun);
      assert.isFalse(
        before.turnItems.some(
          (item) =>
            item.type === "user_message" &&
            (item.messageId === firstQueuedRun.userMessageId ||
              item.messageId === secondQueuedRun.userMessageId),
        ),
        "queued messages must not exist as turn items before dispatch",
      );

      const promotedRunIds = yield* Queue.unbounded<RunId>();
      const afterSequence = yield* orchestrator.getThreadEventSequence(threadId);
      yield* eventSink.stream({ threadId, afterSequence }).pipe(
        Stream.runForEach((stored) =>
          stored.event.type === "run.updated" && stored.event.payload.status === "starting"
            ? Queue.offer(promotedRunIds, stored.event.payload.id)
            : Effect.void,
        ),
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;

      const activeCompletedAt = yield* DateTime.now;
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("runtime-layer-serialized-queue-active-completed"),
            type: "run.updated",
            threadId,
            runId: activeRun.id,
            ...(activeRun.rootNodeId === null ? {} : { nodeId: activeRun.rootNodeId }),
            providerInstanceId: activeRun.providerInstanceId,
            occurredAt: activeCompletedAt,
            payload: {
              ...activeRun,
              status: "completed",
              completedAt: activeCompletedAt,
            },
          },
        ],
      });

      assert.equal(yield* Queue.take(promotedRunIds), firstQueuedRun.id);
      const afterFirstPromotion = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(
        afterFirstPromotion.runs.find((run) => run.id === firstQueuedRun.id)?.status,
        "starting",
      );
      assert.equal(
        afterFirstPromotion.runs.find((run) => run.id === secondQueuedRun.id)?.status,
        "queued",
      );
      const promotedMessageItem = afterFirstPromotion.turnItems.find(
        (item) => item.type === "user_message" && item.messageId === firstQueuedRun.userMessageId,
      );
      assert.isDefined(promotedMessageItem);
      if (promotedMessageItem.type !== "user_message") {
        assert.fail("promoted queue item must be a user message");
      }
      assert.equal(promotedMessageItem.inputIntent, "queued_turn");
      assert.isTrue(
        promotedMessageItem.startedAt !== null &&
          DateTime.toEpochMillis(promotedMessageItem.startedAt) >=
            DateTime.toEpochMillis(activeCompletedAt),
      );

      const promotedFirst = afterFirstPromotion.runs.find((run) => run.id === firstQueuedRun.id);
      assert.isDefined(promotedFirst);
      const firstCompletedAt = yield* DateTime.now;
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("runtime-layer-serialized-queue-first-completed"),
            type: "run.updated",
            threadId,
            runId: promotedFirst.id,
            ...(promotedFirst.rootNodeId === null ? {} : { nodeId: promotedFirst.rootNodeId }),
            providerInstanceId: promotedFirst.providerInstanceId,
            occurredAt: firstCompletedAt,
            payload: {
              ...promotedFirst,
              status: "completed",
              completedAt: firstCompletedAt,
            },
          },
        ],
      });

      assert.equal(yield* Queue.take(promotedRunIds), secondQueuedRun.id);
      const afterSecondPromotion = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(
        afterSecondPromotion.runs.find((run) => run.id === firstQueuedRun.id)?.status,
        "completed",
      );
      assert.equal(
        afterSecondPromotion.runs.find((run) => run.id === secondQueuedRun.id)?.status,
        "starting",
      );
    }),
  );

  it.effect("edits and removes queued runs", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const threadId = ThreadId.make("runtime-layer-queued-edit-thread");

      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-queued-edit-create"),
        threadId,
        projectId: ProjectId.make("runtime-layer-queued-edit-project"),
        title: "Edit queued work",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: "/tmp/runtime-layer-queued-edit",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-queued-edit-active-message"),
        threadId,
        messageId: MessageId.make("runtime-layer-queued-edit-active-message"),
        text: "Keep the provider occupied.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-queued-edit-queued-message"),
        threadId,
        messageId: MessageId.make("runtime-layer-queued-edit-queued-message"),
        text: "Original queued text.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "queue_after_active" },
      });

      const before = yield* orchestrator.getThreadProjection(threadId);
      const queuedRun = before.runs.find((run) => run.status === "queued");
      assert.isDefined(queuedRun);

      yield* orchestrator.dispatch({
        type: "queued-run.edit",
        commandId: CommandId.make("runtime-layer-queued-edit-edit"),
        threadId,
        runId: queuedRun.id,
        text: "Updated queued text.",
      });

      const afterEdit = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(
        afterEdit.messages.find((message) => message.id === queuedRun.userMessageId)?.text,
        "Updated queued text.",
      );
      const editedItem = afterEdit.turnItems.find(
        (item) => item.type === "user_message" && item.messageId === queuedRun.userMessageId,
      );
      assert.isUndefined(editedItem, "editing queue state must not create a timeline turn item");

      const emptyEditError = yield* orchestrator
        .dispatch({
          type: "queued-run.edit",
          commandId: CommandId.make("runtime-layer-queued-edit-empty"),
          threadId,
          runId: queuedRun.id,
          text: "   ",
        })
        .pipe(Effect.flip);
      assert.equal(emptyEditError._tag, "OrchestratorDispatchError");

      yield* orchestrator.dispatch({
        type: "queued-run.cancel",
        commandId: CommandId.make("runtime-layer-queued-edit-cancel"),
        threadId,
        runId: queuedRun.id,
      });

      const afterCancel = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(afterCancel.runs.find((run) => run.id === queuedRun.id)?.status, "cancelled");
      assert.equal(
        afterCancel.attempts.find((attempt) => attempt.runId === queuedRun.id)?.status,
        "cancelled",
      );
      assert.equal(
        afterCancel.nodes.find((node) => node.runId === queuedRun.id)?.status,
        "cancelled",
      );
      assert.isFalse(
        afterCancel.visibleTurnItems.some(
          (row) => row.item.type === "user_message" && row.item.runId === queuedRun.id,
        ),
        "removed queued message must not surface as a transcript row",
      );
      assert.equal(yield* orchestrator.resumeQueuedRuns, 0);

      const cancelAgainError = yield* orchestrator
        .dispatch({
          type: "queued-run.cancel",
          commandId: CommandId.make("runtime-layer-queued-edit-cancel-again"),
          threadId,
          runId: queuedRun.id,
        })
        .pipe(Effect.flip);
      assert.equal(cancelAgainError._tag, "OrchestratorDispatchError");
    }),
  );
});

it.layer(SharedApplicationDataPlaneTestLayer)("pending provider interruption", (it) => {
  it.effect("interrupts a pending provider start without launching provider work", () =>
    Effect.gen(function* () {
      const applicationEngine = yield* OrchestrationEngineService;
      const orchestrator = yield* OrchestratorV2;
      const threadManagement = yield* ThreadManagementService;
      const effectWorker = yield* OrchestrationEffectWorkerV2;
      const projectId = ProjectId.make("runtime-layer-pending-interrupt-project");
      const threadId = ThreadId.make("runtime-layer-pending-interrupt-thread");

      yield* applicationEngine.dispatch({
        type: "project.create",
        commandId: CommandId.make("runtime-layer-pending-interrupt-project-create"),
        projectId,
        title: "Pending interrupt project",
        workspaceRoot: "/tmp/runtime-layer-pending-interrupt-project",
        defaultModelSelection: modelSelection,
        scripts: [],
        createdAt: "2026-06-22T00:00:00.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-pending-interrupt-create"),
        threadId,
        projectId,
        title: "Pending interrupt",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-pending-interrupt-message"),
        threadId,
        messageId: MessageId.make("runtime-layer-pending-interrupt-message"),
        text: "Do not reach the provider.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });

      const starting = yield* orchestrator.getThreadProjection(threadId);
      const run = starting.runs[0];
      assert.isDefined(run);
      assert.equal(run.status, "starting");

      const interrupt = yield* threadManagement.interruptThread({
        projectId,
        commandId: CommandId.make("runtime-layer-pending-interrupt-command"),
        threadId,
        runId: run.id,
        reason: "Cancelled before provider start",
      });
      assert.equal(interrupt.type, "interrupt_requested");

      const interrupted = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(interrupted.runs[0]?.status, "interrupted");
      assert.equal(interrupted.attempts[0]?.status, "interrupted");
      assert.equal(
        interrupted.nodes.find((node) => node.kind === "root_turn")?.status,
        "interrupted",
      );
      assert.deepEqual(
        interrupted.turnItems.filter((item) => item.runId === run.id).map((item) => item.type),
        ["user_message", "run_interrupt_request", "run_interrupt_result"],
      );
      assert.deepEqual(interrupted.providerTurns, []);
      assert.isFalse(yield* effectWorker.runOnce);
    }),
  );
});

it.layer(SharedApplicationDataPlaneTestLayer)("snooze projection", (it) => {
  it.effect("carries snooze state through the V2 shell projection", () =>
    Effect.gen(function* () {
      const applicationEngine = yield* OrchestrationEngineService;
      const orchestrator = yield* OrchestratorV2;
      const projectId = ProjectId.make("runtime-layer-snoozed-project");
      const threadId = ThreadId.make("runtime-layer-snoozed-thread");
      const snoozedUntil = "2099-07-25T09:00:00.000Z";

      yield* applicationEngine.dispatch({
        type: "project.create",
        commandId: CommandId.make("runtime-layer-snoozed-project-create"),
        projectId,
        title: "Snoozed shell projection",
        workspaceRoot: "/tmp/runtime-layer-snoozed-project",
        defaultModelSelection: modelSelection,
        scripts: [],
        createdAt: "2026-07-24T00:00:00.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-snoozed-thread-create"),
        threadId,
        projectId,
        title: "Snoozed thread",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      yield* orchestrator.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("runtime-layer-snoozed-thread-snooze"),
        threadId,
        snoozedUntil,
      });

      const firstProjection = yield* orchestrator.getThreadProjection(threadId);
      const firstSnoozedAt = firstProjection.thread.snoozedAt;
      const firstUpdatedAt = firstProjection.thread.updatedAt;
      assert.isNotNull(firstSnoozedAt);

      yield* orchestrator.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("runtime-layer-snoozed-thread-snooze-again"),
        threadId,
        snoozedUntil,
      });

      const shell = yield* orchestrator.getShellSnapshot();
      const thread = shell.threads.find((candidate) => candidate.id === threadId);
      assert.isDefined(thread);
      assert.equal(DateTime.formatIso(thread.snoozedUntil!), snoozedUntil);
      assert.deepEqual(thread.snoozedAt, firstSnoozedAt);
      assert.deepEqual(thread.updatedAt, firstUpdatedAt);

      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-snoozed-message"),
        threadId,
        messageId: MessageId.make("runtime-layer-snoozed-message"),
        text: "Wake this thread.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });

      const awakened = yield* orchestrator.getThreadProjection(threadId);
      assert.isNull(awakened.thread.snoozedUntil);
      assert.isNull(awakened.thread.snoozedAt);
    }),
  );
});

it.layer(SharedApplicationDataPlaneTestLayer)("visited projection", (it) => {
  it.effect("carries the visited watermark through the V2 shell projection", () =>
    Effect.gen(function* () {
      const applicationEngine = yield* OrchestrationEngineService;
      const orchestrator = yield* OrchestratorV2;
      const projectId = ProjectId.make("runtime-layer-visited-project");
      const threadId = ThreadId.make("runtime-layer-visited-thread");
      const visitedAt = "2026-07-24T01:00:00.000Z";

      yield* applicationEngine.dispatch({
        type: "project.create",
        commandId: CommandId.make("runtime-layer-visited-project-create"),
        projectId,
        title: "Visited shell projection",
        workspaceRoot: "/tmp/runtime-layer-visited-project",
        defaultModelSelection: modelSelection,
        scripts: [],
        createdAt: "2026-07-24T00:00:00.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-visited-thread-create"),
        threadId,
        projectId,
        title: "Visited thread",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const created = yield* orchestrator.getThreadProjection(threadId);
      assert.isNull(created.thread.lastVisitedAt);
      const createdUpdatedAt = created.thread.updatedAt;

      yield* TestClock.adjust("1 second");
      yield* orchestrator.dispatch({
        type: "thread.visit",
        commandId: CommandId.make("runtime-layer-visited-thread-visit"),
        threadId,
        visitedAt,
      });
      const visited = yield* orchestrator.getThreadProjection(threadId);
      assert.isNotNull(visited.thread.lastVisitedAt);
      assert.equal(DateTime.formatIso(visited.thread.lastVisitedAt!), visitedAt);
      // Visiting records read state, not activity: updatedAt must not move.
      assert.deepEqual(visited.thread.updatedAt, createdUpdatedAt);

      // Monotonic: an older watermark (a replay or a stale device) cannot
      // rewind the marker.
      yield* orchestrator.dispatch({
        type: "thread.visit",
        commandId: CommandId.make("runtime-layer-visited-thread-visit-stale"),
        threadId,
        visitedAt: "2026-07-24T00:30:00.000Z",
      });
      const afterStaleVisit = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(DateTime.formatIso(afterStaleVisit.thread.lastVisitedAt!), visitedAt);

      const shell = yield* orchestrator.getShellSnapshot();
      const thread = shell.threads.find((candidate) => candidate.id === threadId);
      assert.isDefined(thread);
      assert.equal(DateTime.formatIso(thread!.lastVisitedAt!), visitedAt);
      assert.deepEqual(thread!.updatedAt, createdUpdatedAt);

      // No completed run yet → nothing to mark unread against.
      const markUnread = yield* orchestrator
        .dispatch({
          type: "thread.mark-unread",
          commandId: CommandId.make("runtime-layer-visited-thread-mark-unread"),
          threadId,
        })
        .pipe(Effect.flip);
      assert.instanceOf(markUnread, OrchestratorDispatchError);
    }),
  );
});

it.layer(SharedApplicationDataPlaneTestLayer)("shared application data plane", (it) => {
  it.effect("orders retained project transactions and V2 thread transactions in one source", () =>
    Effect.gen(function* () {
      const applicationEngine = yield* OrchestrationEngineService;
      const applicationEvents = yield* OrchestrationEventStore;
      const orchestrator = yield* OrchestratorV2;
      const projectionSnapshot = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("runtime-layer-shared-project");
      const threadId = ThreadId.make("runtime-layer-shared-thread");
      const projectCommand = {
        type: "project.create" as const,
        commandId: CommandId.make("runtime-layer-shared-project-create"),
        projectId,
        title: "Shared application source",
        workspaceRoot: "/tmp/runtime-layer-shared-project",
        defaultModelSelection: modelSelection,
        scripts: [],
        createdAt: "2026-06-20T00:00:00.000Z",
      };

      const projectResult = yield* applicationEngine.dispatch(projectCommand);
      const projectRetry = yield* applicationEngine.dispatch(projectCommand);
      assert.equal(projectRetry.sequence, projectResult.sequence);

      const delivered = yield* Queue.unbounded<ApplicationStoredEvent>();
      yield* applicationEvents.streamApplicationEvents().pipe(
        Stream.take(2),
        Stream.runForEach((event) => Queue.offer(delivered, event)),
        Effect.forkScoped,
      );

      const projectEvent = yield* Queue.take(delivered);
      assert.equal(projectEvent.sequence, projectResult.sequence);

      const threadResult = yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-shared-thread-create"),
        threadId,
        projectId,
        title: "Shared thread",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const threadEvent = yield* Queue.take(delivered);

      assert.equal(threadEvent.sequence, threadResult.sequence);
      assert.isAbove(threadEvent.sequence, projectEvent.sequence);
      assert.isTrue("aggregateKind" in projectEvent);
      assert.isTrue("event" in threadEvent);
      assert.equal((yield* projectionSnapshot.getProjectShellById(projectId))._tag, "Some");

      const retainedReceipts = yield* sql<{
        readonly aggregate_kind: string;
        readonly aggregate_id: string;
      }>`
        SELECT aggregate_kind, aggregate_id
        FROM orchestration_command_receipts
        ORDER BY result_sequence ASC
      `;
      assert.deepEqual(retainedReceipts, [
        { aggregate_kind: "project", aggregate_id: projectId },
        { aggregate_kind: "thread", aggregate_id: threadId },
      ]);

      const retiredWrites = yield* sql<{ readonly count: number }>`
        SELECT
          (SELECT COUNT(*) FROM orchestration_v2_events) +
          (SELECT COUNT(*) FROM orchestration_v2_command_receipts) AS count
      `;
      assert.equal(retiredWrites[0]?.count, 0);
    }),
  );
});
