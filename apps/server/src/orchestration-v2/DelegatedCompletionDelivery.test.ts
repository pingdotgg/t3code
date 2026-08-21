import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
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
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectEnrichmentService } from "../project/ProjectEnrichmentService.ts";
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
  prefix: "t3-orchestration-v2-delegated-completion-",
});

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;

const VcsDriverRegistryTestLayer = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProcess.layer),
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
  openSession: () => Effect.die("sessions are not used by delegated completion tests"),
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

const TestLayer = Layer.mergeAll(
  OrchestrationLayerLive,
  OrchestrationV2LayerLive,
  OrchestrationV2EventSinkLayerLive,
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
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(CheckpointStoreTestLayer),
  Layer.provide(ServerConfigLayer),
  Layer.provide(ServerSettingsService.layerTest()),
  Layer.provide(TestProviderInstanceRegistry),
  Layer.provide(NodeServices.layer),
);

const seedParentWithTerminalTask = (input: {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly runId: RunId;
  readonly rootNodeId: NodeId;
  readonly taskId: NodeId;
  readonly deliveryState: "delivered" | "claimed" | "acknowledged" | "disposed";
  readonly completionWake?: "always" | "settled_only";
  readonly deliveryTaskIds?: ReadonlyArray<NodeId>;
  readonly now: DateTime.Utc;
}) =>
  Effect.gen(function* () {
    const applicationEngine = yield* OrchestrationEngineService;
    const orchestrator = yield* OrchestratorV2;
    const eventSink = yield* EventSinkV2;
    const providerThreadId = ProviderThreadId.make(
      `provider-thread:${String(input.threadId).replace("thread:", "")}`,
    );

    yield* applicationEngine.dispatch({
      type: "project.create",
      commandId: CommandId.make(`command:seed-project:${input.threadId}`),
      projectId: input.projectId,
      title: "Delegated completion delivery",
      workspaceRoot: `/workspace/${input.projectId}`,
      defaultModelSelection: modelSelection,
      scripts: [],
      createdAt: DateTime.formatIso(input.now),
    });

    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`command:seed-create:${input.threadId}`),
      threadId: input.threadId,
      projectId: input.projectId,
      title: "Delegated completion delivery",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });

    yield* eventSink.write({
      commandId: CommandId.make(`command:seed-projection:${input.threadId}`),
      events: [
        {
          id: EventId.make(`event:seed-provider-thread:${input.threadId}`),
          type: "provider-thread.updated",
          threadId: input.threadId,
          driver,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: input.now,
          payload: {
            id: providerThreadId,
            driver,
            providerInstanceId: modelSelection.instanceId,
            providerSessionId: null,
            appThreadId: input.threadId,
            ownerNodeId: input.rootNodeId,
            nativeThreadRef: {
              driver,
              nativeId: `native:${input.threadId}`,
              strength: "strong",
            },
            nativeConversationHeadRef: null,
            status: "active",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: input.now,
            updatedAt: input.now,
          },
        },
        {
          id: EventId.make(`event:seed-run:${input.threadId}`),
          type: "run.updated",
          threadId: input.threadId,
          runId: input.runId,
          nodeId: input.rootNodeId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: input.now,
          payload: {
            id: input.runId,
            threadId: input.threadId,
            ordinal: 1,
            providerInstanceId: modelSelection.instanceId,
            modelSelection,
            providerThreadId,
            userMessageId: MessageId.make(`message:seed-user:${input.threadId}`),
            rootNodeId: input.rootNodeId,
            activeAttemptId: null,
            status: "running",
            requestedAt: input.now,
            startedAt: input.now,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
            delegatedCompletion: {
              disposition: "open",
              nextGeneration: 2,
              settledDeliveryCount: 1,
              delivery:
                input.deliveryTaskIds === undefined
                  ? null
                  : {
                      generation: 1,
                      messageId: MessageId.make(`message:delegated-delivery:${input.threadId}`),
                      taskIds: input.deliveryTaskIds,
                    },
            },
          },
        },
        {
          id: EventId.make(`event:seed-task:${input.threadId}`),
          type: "subagent.updated",
          threadId: input.threadId,
          runId: input.runId,
          nodeId: input.taskId,
          driver,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: input.now,
          payload: {
            id: input.taskId,
            kind: "subagent" as const,
            role: { name: "general-purpose", source: "app_default" as const },
            usage: null,
            currentActivationId: null,
            activationCount: 1,
            workflow: null,
            workflowMembership: null,
            recentActivity: [],
            threadId: input.threadId,
            runId: input.runId,
            parentNodeId: input.rootNodeId,
            origin: "app_owned",
            createdBy: "agent",
            driver,
            providerInstanceId: modelSelection.instanceId,
            providerThreadId: null,
            childThreadId: null,
            nativeTaskRef: null,
            prompt: "Inspect the delivered ownership edge.",
            title: null,
            model: null,
            completionWake: input.completionWake ?? "settled_only",
            completionDelivery: {
              state: input.deliveryState,
              observedByRunId: input.deliveryState === "acknowledged" ? input.runId : null,
            },
            status: "completed",
            result: "child finished",
            startedAt: input.now,
            completedAt: input.now,
            updatedAt: input.now,
          },
        },
      ],
    });
  });

it.layer(TestLayer)("delegated completion delivery repairs", (it) => {
  it.effect("builds completion text and metadata from the same live cohort", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:delegated-delivery-live-cohort");
      const projectId = ProjectId.make("project:delegated-delivery-live-cohort");
      const runId = RunId.make("run:delegated-delivery-live-cohort");
      const rootNodeId = NodeId.make("node:delegated-delivery-live-cohort-root");
      const firstTaskId = NodeId.make("node:delegated-delivery-live-cohort-first");
      const secondTaskId = NodeId.make("node:delegated-delivery-live-cohort-second");
      const messageId = MessageId.make(`message:delegated-delivery:${threadId}`);

      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId: firstTaskId,
        deliveryState: "claimed",
        completionWake: "always",
        deliveryTaskIds: [firstTaskId, secondTaskId],
        now,
      });

      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("command:delegated-delivery-live-cohort"),
        threadId,
        messageId,
        text: `Delegated task ${firstTaskId} reached a terminal state.`,
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
        delegatedCompletion: {
          parentRunId: runId,
          generation: 1,
          taskIds: [firstTaskId],
        },
      });

      const projection = yield* orchestrator.getThreadProjection(threadId);
      const message = projection.messages.find((candidate) => candidate.id === messageId);
      assert.deepEqual(message?.delegatedCompletion?.taskIds, [firstTaskId, secondTaskId]);
      assert.include(message?.text ?? "", String(firstTaskId));
      assert.include(message?.text ?? "", String(secondTaskId));
      assert.include(message?.text ?? "", "task_status");
    }),
  );

  it.effect("does not re-offer when wake-policy upgrades after delivered ownership settled", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:delegated-delivery-a1");
      const projectId = ProjectId.make("project:delegated-delivery-a1");
      const runId = RunId.make("run:delegated-delivery-a1");
      const rootNodeId = NodeId.make("node:delegated-delivery-a1-root");
      const taskId = NodeId.make("node:delegated-delivery-a1-task");

      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId,
        deliveryState: "delivered",
        completionWake: "settled_only",
        now,
      });

      const upgrade = yield* orchestrator.dispatch({
        type: "delegated_task.wake-policy",
        commandId: CommandId.make("command:delegated-delivery-a1:wake-policy"),
        parentThreadId: threadId,
        taskId,
        completionWake: "always",
      });

      const projection = yield* orchestrator.getThreadProjection(threadId);
      const task = projection.subagents.find((candidate) => candidate.id === taskId);
      const parentRun = projection.runs.find((candidate) => candidate.id === runId);

      assert.equal(task?.completionWake, "always");
      assert.deepEqual(task?.completionDelivery, {
        state: "delivered",
        observedByRunId: null,
      });
      assert.deepEqual(parentRun?.delegatedCompletion, {
        disposition: "open",
        nextGeneration: 2,
        settledDeliveryCount: 1,
        delivery: null,
      });
      assert.isFalse(
        upgrade.storedEvents.some(
          (stored) =>
            stored.event.type === "subagent.updated" &&
            stored.event.payload.id === taskId &&
            stored.event.payload.completionDelivery?.state === "claimed",
        ),
      );
      assert.isFalse(
        upgrade.storedEvents.some(
          (stored) =>
            stored.event.type === "run.updated" &&
            stored.event.payload.id === runId &&
            stored.event.payload.delegatedCompletion?.delivery !== null &&
            stored.event.payload.delegatedCompletion?.delivery !== undefined,
        ),
      );
    }),
  );

  it.effect(
    "treats repeated acknowledge and dispose with distinct command IDs as successful no-ops",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* OrchestratorV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread:delegated-delivery-a2");
        const projectId = ProjectId.make("project:delegated-delivery-a2");
        const runId = RunId.make("run:delegated-delivery-a2");
        const rootNodeId = NodeId.make("node:delegated-delivery-a2-root");
        const taskId = NodeId.make("node:delegated-delivery-a2-task");

        yield* seedParentWithTerminalTask({
          threadId,
          projectId,
          runId,
          rootNodeId,
          taskId,
          deliveryState: "delivered",
          completionWake: "always",
          now,
        });

        // Distinct command IDs mirror task_status vs t3_thread_read racing after
        // their shared read preflight saw delivered ownership.
        const firstAck = yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.acknowledge",
          commandId: CommandId.make("command:delegated-delivery-a2:ack-task-status"),
          parentThreadId: threadId,
          taskId,
          observedByRunId: runId,
        });
        const secondAck = yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.acknowledge",
          commandId: CommandId.make("command:delegated-delivery-a2:ack-thread-read"),
          parentThreadId: threadId,
          taskId,
          observedByRunId: runId,
        });

        const firstAckTask = firstAck.storedEvents.find(
          (stored) =>
            stored.event.type === "subagent.updated" && stored.event.payload.id === taskId,
        );
        const secondAckTask = secondAck.storedEvents.find(
          (stored) =>
            stored.event.type === "subagent.updated" && stored.event.payload.id === taskId,
        );
        assert.isDefined(firstAckTask);
        assert.isDefined(secondAckTask);
        if (
          firstAckTask?.event.type !== "subagent.updated" ||
          secondAckTask?.event.type !== "subagent.updated"
        ) {
          return yield* Effect.die(new Error("Acknowledge events missing."));
        }
        assert.equal(firstAckTask.event.payload.completionDelivery?.state, "acknowledged");
        assert.equal(secondAckTask.event.payload.completionDelivery?.state, "acknowledged");
        // Idempotent replay keeps the first observation's ownership and timestamp.
        assert.deepEqual(
          secondAckTask.event.payload.completionDelivery,
          firstAckTask.event.payload.completionDelivery,
        );
        assert.deepEqual(
          secondAckTask.event.payload.updatedAt,
          firstAckTask.event.payload.updatedAt,
        );
        assert.equal(secondAck.storedEvents.length, 1);

        const afterAck = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(
          afterAck.subagents.find((candidate) => candidate.id === taskId)?.completionDelivery,
          {
            state: "acknowledged",
            observedByRunId: runId,
          },
        );

        const firstDispose = yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.dispose",
          commandId: CommandId.make("command:delegated-delivery-a2:dispose-task-status"),
          parentThreadId: threadId,
          taskId,
        });
        const secondDispose = yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.dispose",
          commandId: CommandId.make("command:delegated-delivery-a2:dispose-thread-read"),
          parentThreadId: threadId,
          taskId,
        });

        const firstDisposeTask = firstDispose.storedEvents.find(
          (stored) =>
            stored.event.type === "subagent.updated" && stored.event.payload.id === taskId,
        );
        const secondDisposeTask = secondDispose.storedEvents.find(
          (stored) =>
            stored.event.type === "subagent.updated" && stored.event.payload.id === taskId,
        );
        assert.isDefined(firstDisposeTask);
        assert.isDefined(secondDisposeTask);
        if (
          firstDisposeTask?.event.type !== "subagent.updated" ||
          secondDisposeTask?.event.type !== "subagent.updated"
        ) {
          return yield* Effect.die(new Error("Dispose events missing."));
        }
        assert.equal(firstDisposeTask.event.payload.completionDelivery?.state, "disposed");
        assert.equal(secondDisposeTask.event.payload.completionDelivery?.state, "disposed");
        assert.deepEqual(
          secondDisposeTask.event.payload.completionDelivery,
          firstDisposeTask.event.payload.completionDelivery,
        );
        assert.equal(secondDispose.storedEvents.length, 1);

        const afterDispose = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(
          afterDispose.subagents.find((candidate) => candidate.id === taskId)?.completionDelivery,
          {
            state: "disposed",
            observedByRunId: null,
          },
        );

        const acknowledgeAfterDispose = yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.acknowledge",
          commandId: CommandId.make("command:delegated-delivery-a2:ack-after-dispose"),
          parentThreadId: threadId,
          taskId,
          observedByRunId: runId,
        });
        const acknowledgedTask = acknowledgeAfterDispose.storedEvents.find(
          (stored) => stored.event.type === "subagent.updated",
        );
        if (acknowledgedTask?.event.type !== "subagent.updated") {
          return yield* Effect.die(new Error("Acknowledge-after-dispose event missing."));
        }
        assert.deepEqual(acknowledgedTask.event.payload.completionDelivery, {
          state: "disposed",
          observedByRunId: null,
        });
        assert.equal(acknowledgeAfterDispose.storedEvents.length, 1);

        const afterStaleAcknowledge = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(
          afterStaleAcknowledge.subagents.find((candidate) => candidate.id === taskId)
            ?.completionDelivery,
          {
            state: "disposed",
            observedByRunId: null,
          },
        );
      }),
  );
});
