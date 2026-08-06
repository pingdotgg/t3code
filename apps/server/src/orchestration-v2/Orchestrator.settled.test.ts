import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { ServerConfig } from "../config.ts";
import { layer as mcpSessionRegistryTestLayer } from "../mcp/McpSessionRegistry.testkit.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import { OrchestrationV2EventSinkLayerLive, OrchestrationV2LayerLive } from "./runtimeLayer.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-orchestration-v2-settled-",
});

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;

const driver = ProviderDriverKind.make("codex");
const orchestrationAdapter = {
  instanceId: modelSelection.instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("sessions are not used by settle tests"),
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

const VcsDriverRegistryTestLayer = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(ServerConfigLayer),
  Layer.provide(NodeServices.layer),
);

const CheckpointStoreTestLayer = CheckpointStore.layer.pipe(
  Layer.provide(VcsDriverRegistryTestLayer),
);

const TestLayer = Layer.merge(OrchestrationV2LayerLive, OrchestrationV2EventSinkLayerLive).pipe(
  Layer.provide(mcpSessionRegistryTestLayer),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(CheckpointStoreTestLayer),
  Layer.provide(ServerConfigLayer),
  Layer.provide(ServerSettingsService.layerTest()),
  Layer.provide(TestProviderInstanceRegistry),
  Layer.provide(NodeServices.layer),
);

function createThreadCommand(input: {
  readonly commandId: string;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
}) {
  return {
    type: "thread.create" as const,
    createdBy: "user" as const,
    creationSource: "web" as const,
    commandId: CommandId.make(input.commandId),
    threadId: input.threadId,
    projectId: input.projectId,
    title: "Settled lifecycle thread",
    modelSelection,
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    branch: null,
    worktreePath: null,
  };
}

function makeRun(input: {
  readonly runId: RunId;
  readonly threadId: ThreadId;
  readonly status: OrchestrationV2Run["status"];
  readonly now: DateTime.Utc;
  readonly providerThreadId?: ProviderThreadId | null;
}): OrchestrationV2Run {
  return {
    id: input.runId,
    threadId: input.threadId,
    ordinal: 1,
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
    providerThreadId: input.providerThreadId ?? null,
    userMessageId: MessageId.make(`message:${input.runId}`),
    rootNodeId: NodeId.make(`node:${input.runId}`),
    activeAttemptId: null,
    status: input.status,
    requestedAt: input.now,
    startedAt: input.status === "queued" || input.status === "preparing" ? null : input.now,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
    ...(input.status === "queued" ? { queuePosition: 1 } : {}),
  };
}

function makeProviderThread(input: {
  readonly id: ProviderThreadId;
  readonly threadId: ThreadId;
  readonly now: DateTime.Utc;
  readonly pendingBackgroundTasks?: OrchestrationV2ProviderThread["pendingBackgroundTasks"];
}): OrchestrationV2ProviderThread {
  return {
    id: input.id,
    driver,
    providerInstanceId: modelSelection.instanceId,
    providerSessionId: null,
    appThreadId: input.threadId,
    ownerNodeId: null,
    nativeThreadRef: {
      driver,
      nativeId: String(input.id),
      strength: "strong",
    },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: 1,
    lastRunOrdinal: 1,
    handoffIds: [],
    forkedFrom: null,
    pendingBackgroundTasks: input.pendingBackgroundTasks ?? [],
    createdAt: input.now,
    updatedAt: input.now,
  };
}

it.layer(TestLayer)("OrchestratorV2 settled lifecycle invariants", (it) => {
  it.effect("settles an idle thread and rejects settle while a run is queued", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const eventSink = yield* EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:settle-queued");
      const projectId = ProjectId.make("project:settle-queued");

      yield* orchestrator.dispatch(
        createThreadCommand({
          commandId: "cmd:settle-queued:create",
          threadId,
          projectId,
        }),
      );

      const idleSettle = yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("cmd:settle-queued:idle"),
        threadId,
      });
      assert.equal(idleSettle.storedEvents[0]?.event.type, "thread.settled");

      // Unsettle so the next settle attempt is not an idempotent re-emit.
      yield* orchestrator.dispatch({
        type: "thread.unsettle",
        commandId: CommandId.make("cmd:settle-queued:unsettle"),
        threadId,
        reason: "user",
      });

      const runId = RunId.make("run:settle-queued");
      const runEvent = {
        id: EventId.make("event:settle-queued:run"),
        type: "run.created" as const,
        threadId,
        runId,
        nodeId: NodeId.make("node:settle-queued"),
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: makeRun({ runId, threadId, status: "queued", now }),
      } satisfies OrchestrationV2DomainEvent;
      yield* eventSink.write({ events: [runEvent] });

      const rejected = yield* orchestrator
        .dispatch({
          type: "thread.settle",
          commandId: CommandId.make("cmd:settle-queued:blocked"),
          threadId,
        })
        .pipe(Effect.flip);
      assert.equal(rejected._tag, "OrchestratorDispatchError");
      if (rejected._tag === "OrchestratorDispatchError") {
        assert.match(String(rejected.cause), /queued run/i);
      }

      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(projection.thread.settledOverride, "active");
    }),
  );

  it.effect("rejects settle while pending background tasks remain on the shell", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const eventSink = yield* EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:settle-background");
      const projectId = ProjectId.make("project:settle-background");
      const providerThreadId = ProviderThreadId.make("provider-thread:settle-background");
      const runId = RunId.make("run:settle-background");

      yield* orchestrator.dispatch(
        createThreadCommand({
          commandId: "cmd:settle-background:create",
          threadId,
          projectId,
        }),
      );

      const created = yield* orchestrator.getThreadProjection(threadId);
      // Terminal latest run + non-empty background roster on the active
      // provider thread: shell is waiting and must not settle.
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("event:settle-background:run"),
            type: "run.created",
            threadId,
            runId,
            nodeId: NodeId.make("node:settle-background"),
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: {
              ...makeRun({
                runId,
                threadId,
                status: "completed",
                now,
                providerThreadId,
              }),
              completedAt: now,
            },
          },
          {
            id: EventId.make("event:settle-background:provider-thread"),
            type: "provider-thread.updated",
            threadId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: makeProviderThread({
              id: providerThreadId,
              threadId,
              now,
              pendingBackgroundTasks: [{ taskId: "bg-1", description: "sleep 30" }],
            }),
          },
          {
            id: EventId.make("event:settle-background:pin-active-provider"),
            type: "thread.metadata-updated",
            threadId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: {
              ...created.thread,
              activeProviderThreadId: providerThreadId,
              updatedAt: now,
            },
          },
        ],
      });

      const rejected = yield* orchestrator
        .dispatch({
          type: "thread.settle",
          commandId: CommandId.make("cmd:settle-background:blocked"),
          threadId,
        })
        .pipe(Effect.flip);
      assert.equal(rejected._tag, "OrchestratorDispatchError");
      if (rejected._tag === "OrchestratorDispatchError") {
        assert.match(String(rejected.cause), /background tasks/i);
      }
    }),
  );
});
