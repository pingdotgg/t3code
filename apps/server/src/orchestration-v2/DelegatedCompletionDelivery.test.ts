import { SourceControlProviderRegistry } from "../sourceControl/SourceControlProviderRegistry.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ContextTransferId,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  RuntimeRequestId,
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
import { ProjectEnrichmentService } from "../project/ProjectEnrichmentService.ts";
import { ProjectService } from "../project/ProjectService.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { WorkspacePaths } from "../workspace/WorkspacePaths.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import {
  OrchestrationV2EventSinkLayerLive,
  OrchestrationV2LayerLive,
  ProjectServiceLayerLive,
} from "./runtimeLayer.ts";
import { worktreeRepairDependenciesTestLayer } from "./ProviderTurnStartService.testkit.ts";
import { makeSubagentChildThread } from "./SubagentProjection.ts";

const PlatformTestLayer = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry)({ resolveLink: () => Effect.die("unused title link") }),
);

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
  Layer.provide(PlatformTestLayer),
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
  // No supportedRuntimeModes: every runtime mode runs as stored.
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
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

const TestLayer = Layer.mergeAll(OrchestrationV2LayerLive, OrchestrationV2EventSinkLayerLive).pipe(
  Layer.provideMerge(ProjectServiceLayerLive),
  Layer.provide(
    Layer.mock(WorkspacePaths)({
      normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    }),
  ),
  Layer.provide(worktreeRepairDependenciesTestLayer),
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
  Layer.provide(PlatformTestLayer),
);

const seedParentWithTerminalTask = (input: {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly runId: RunId;
  readonly rootNodeId: NodeId;
  readonly taskId: NodeId;
  /** Omit for a task that is still running. */
  readonly deliveryState?: "delivered" | "claimed" | "acknowledged" | "disposed";
  readonly completionWake?: "always" | "settled_only";
  readonly deliveryTaskIds?: ReadonlyArray<NodeId>;
  readonly now: DateTime.Utc;
}) =>
  Effect.gen(function* () {
    const projects = yield* ProjectService;
    const orchestrator = yield* OrchestratorV2;
    const eventSink = yield* EventSinkV2;
    const providerThreadId = ProviderThreadId.make(
      `provider-thread:${String(input.threadId).replace("thread:", "")}`,
    );

    yield* projects.create({
      commandId: CommandId.make(`command:seed-project:${input.threadId}`),
      projectId: input.projectId,
      title: "Delegated completion delivery",
      workspaceRoot: `/workspace/${input.projectId}`,
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
            ...(input.deliveryState === undefined
              ? { status: "running" as const, result: null, completedAt: null }
              : {
                  completionDelivery: {
                    state: input.deliveryState,
                    observedByRunId: input.deliveryState === "acknowledged" ? input.runId : null,
                  },
                  status: "completed" as const,
                  result: "child finished",
                  completedAt: input.now,
                }),
            startedAt: input.now,
            updatedAt: input.now,
          },
        },
      ],
    });
  });

it.layer(TestLayer)("delegated completion delivery repairs", (it) => {
  it.effect("acceptance batches pending siblings without acknowledging their results", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const sink = yield* EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("mailbox-batch");
      const runId = RunId.make("mailbox-parent");
      const taskId = NodeId.make("mailbox-first");
      const messageId = MessageId.make(`message:delegated-delivery:${threadId}`);
      yield* seedParentWithTerminalTask({
        threadId,
        runId,
        projectId: ProjectId.make("mailbox-project"),
        rootNodeId: NodeId.make("mailbox-root"),
        taskId,
        deliveryState: "claimed",
        completionWake: "always",
        deliveryTaskIds: [taskId],
        now,
      });
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const task = projection.subagents[0]!;
      const pendingIds = [NodeId.make("mailbox-second"), NodeId.make("mailbox-third")];
      yield* sink.write({
        events: [
          {
            id: EventId.make("mailbox-message"),
            type: "message.updated",
            threadId,
            runId,
            occurredAt: now,
            payload: {
              id: messageId,
              threadId,
              runId,
              nodeId: task.parentNodeId,
              role: "user",
              text: "Background task finished",
              attachments: [],
              streaming: false,
              createdBy: "agent",
              creationSource: "server",
              createdAt: now,
              updatedAt: now,
              delegatedCompletion: { parentRunId: runId, generation: 1, taskIds: [taskId] },
            },
          },
          ...pendingIds.map((id) => ({
            id: EventId.make(`event:${id}`),
            type: "subagent.updated" as const,
            threadId,
            runId,
            nodeId: id,
            occurredAt: now,
            payload: {
              ...task,
              id,
              completionDelivery: { state: "pending" as const, observedByRunId: null },
            },
          })),
        ],
      });
      yield* orchestrator.dispatch({
        type: "notification.delivery.accept",
        commandId: CommandId.make("accept-first"),
        threadId,
        messageId,
      });
      const accepted = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(
        accepted.subagents.find((row) => row.id === taskId)?.completionDelivery?.state,
        "delivered",
      );
      const cohort = accepted.runs.find((row) => row.id === runId)?.delegatedCompletion;
      assert.deepEqual(cohort?.delivery?.taskIds, pendingIds);
      assert.equal(cohort?.delivery?.generation, 2);
      for (const id of pendingIds) {
        assert.deepEqual(accepted.subagents.find((row) => row.id === id)?.completionDelivery, {
          state: "claimed",
          observedByRunId: null,
        });
      }
      yield* orchestrator.dispatch({
        type: "notification.delivery.accept",
        commandId: CommandId.make("repeat-old-acceptance"),
        threadId,
        messageId,
      });
      const duplicate = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(duplicate.runs.find((row) => row.id === runId)?.delegatedCompletion, cohort);
    }),
  );

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

it.layer(TestLayer)("paused delegated task wakes", (it) => {
  /** Gives a seeded running task the child thread its wake is traced back through. */
  const attachChildThread = (input: {
    readonly parentThreadId: ThreadId;
    readonly taskId: NodeId;
    readonly childThreadId: ThreadId;
    readonly completionWake: "always" | "settled_only";
    readonly now: DateTime.Utc;
  }) =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const sink = yield* EventSinkV2;
      const parent = yield* orchestrator.getThreadProjection(input.parentThreadId);
      const seeded = parent.subagents[0]!;
      yield* sink.write({
        events: [
          {
            id: EventId.make(`event:paused-child:${input.childThreadId}`),
            type: "thread.created",
            threadId: input.childThreadId,
            driver,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: input.now,
            payload: makeSubagentChildThread({
              parentThread: parent.thread,
              childThreadId: input.childThreadId,
              parentNodeId: input.taskId,
              activeProviderThreadId: null,
              providerInstanceId: modelSelection.instanceId,
              modelSelection,
              title: "Paused child",
              now: input.now,
              createdBy: "agent",
              creationSource: "mcp",
            }),
          },
          {
            id: EventId.make(`event:paused-task:${input.taskId}`),
            type: "subagent.updated",
            threadId: input.parentThreadId,
            runId: seeded.runId ?? undefined,
            nodeId: input.taskId,
            occurredAt: input.now,
            payload: {
              ...seeded,
              id: input.taskId,
              childThreadId: input.childThreadId,
              completionWake: input.completionWake,
            },
          },
        ],
      });
    });

  const pendingRequest = (input: {
    readonly childThreadId: ThreadId;
    readonly requestId: RuntimeRequestId;
    readonly kind: "command" | "user_input";
    readonly status?: "pending" | "resolved";
    readonly now: DateTime.Utc;
  }) => ({
    id: EventId.make(`event:${input.requestId}:${input.status ?? "pending"}`),
    type: "runtime-request.updated" as const,
    threadId: input.childThreadId,
    occurredAt: input.now,
    payload: {
      id: input.requestId,
      nodeId: NodeId.make(`node:${input.requestId}`),
      providerTurnId: null,
      nativeRequestRef: null,
      kind: input.kind,
      status: input.status ?? ("pending" as const),
      responseCapability: {
        type: "live" as const,
        providerSessionId: ProviderSessionId.make("provider-session:paused-child"),
      },
      createdAt: input.now,
      resolvedAt: input.status === "resolved" ? input.now : null,
    },
  });

  /** A parent with a live run and one async task whose child thread can pause. */
  const seedParentWithAsyncChild = (name: string, now: DateTime.Utc) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make(`thread:${name}-parent`);
      const childThreadId = ThreadId.make(`thread:${name}-child`);
      const taskId = NodeId.make(`node:${name}-task`);
      yield* seedParentWithTerminalTask({
        threadId,
        projectId: ProjectId.make(`project:${name}`),
        runId: RunId.make(`run:${name}-parent`),
        rootNodeId: NodeId.make(`node:${name}-root`),
        taskId,
        now,
      });
      yield* attachChildThread({
        parentThreadId: threadId,
        taskId,
        childThreadId,
        completionWake: "always",
        now,
      });
      return { threadId, childThreadId, taskId };
    });

  /**
   * Requests are handled in order, so once the wake for a later request has
   * landed, every earlier request has already been decided.
   */
  const awaitWake = (parentThreadId: ThreadId, afterSequence: number, summaryPart: string) =>
    Effect.gen(function* () {
      const sink = yield* EventSinkV2;
      yield* sink.stream({ afterSequence, eventType: "message.updated" }).pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "message.updated" &&
            stored.event.threadId === parentThreadId &&
            (stored.event.payload.notification?.summary.includes(summaryPart) ?? false),
        ),
        Stream.runHead,
      );
      const orchestrator = yield* OrchestratorV2;
      const parent = yield* orchestrator.getThreadProjection(parentThreadId);
      return parent.messages.filter((message) => message.notification !== undefined);
    });

  it.effect("wakes the parent once for approvals and again for each question", () =>
    Effect.gen(function* () {
      const sink = yield* EventSinkV2;
      const now = yield* DateTime.now;
      const questionId = RuntimeRequestId.make("runtime-request:paused-task-question");
      const { threadId, childThreadId, taskId } = yield* seedParentWithAsyncChild(
        "paused-task",
        now,
      );
      const afterSequence = yield* sink.latestSequence();

      yield* sink.write({
        events: [
          pendingRequest({
            childThreadId,
            requestId: RuntimeRequestId.make("runtime-request:paused-task-approval-1"),
            kind: "command",
            now,
          }),
          pendingRequest({
            childThreadId,
            requestId: RuntimeRequestId.make("runtime-request:paused-task-approval-2"),
            kind: "command",
            now,
          }),
          pendingRequest({ childThreadId, requestId: questionId, kind: "user_input", now }),
        ],
      });

      const [approval, question, ...rest] = yield* awaitWake(threadId, afterSequence, "an answer");
      assert.deepEqual(rest, []);
      assert.deepEqual(approval?.notification, {
        source: { kind: "delegated_task", taskIds: [taskId], childThreadId },
        outcome: "updated",
        summary: 'Delegated task "Inspect the delivered ownership edge." is waiting for approval',
      });
      assert.include(approval?.text ?? "", String(taskId));
      assert.include(approval?.text ?? "", "task_cancel");
      assert.equal(
        question?.notification?.summary,
        'Delegated task "Inspect the delivered ownership edge." is waiting for an answer',
      );
      assert.include(question?.text ?? "", String(questionId));
      assert.include(question?.text ?? "", "t3_pending_request_respond");
    }),
  );

  it.effect("leaves a blocking wait to report its own paused child", () =>
    Effect.gen(function* () {
      const sink = yield* EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:paused-wait-parent");
      const waitedChildThreadId = ThreadId.make("thread:paused-wait-child");
      const asyncChildThreadId = ThreadId.make("thread:paused-wait-async-child");
      const waitedTaskId = NodeId.make("node:paused-wait-task");
      const asyncTaskId = NodeId.make("node:paused-wait-async-task");
      yield* seedParentWithTerminalTask({
        threadId,
        projectId: ProjectId.make("project:paused-wait"),
        runId: RunId.make("run:paused-wait-parent"),
        rootNodeId: NodeId.make("node:paused-wait-root"),
        taskId: waitedTaskId,
        now,
      });
      // The parent's run is live, so its mode=wait call is still polling the first task.
      yield* attachChildThread({
        parentThreadId: threadId,
        taskId: waitedTaskId,
        childThreadId: waitedChildThreadId,
        completionWake: "settled_only",
        now,
      });
      yield* attachChildThread({
        parentThreadId: threadId,
        taskId: asyncTaskId,
        childThreadId: asyncChildThreadId,
        completionWake: "always",
        now,
      });
      const afterSequence = yield* sink.latestSequence();

      yield* sink.write({
        events: [
          pendingRequest({
            childThreadId: waitedChildThreadId,
            requestId: RuntimeRequestId.make("runtime-request:paused-wait-approval"),
            kind: "command",
            now,
          }),
          pendingRequest({
            childThreadId: asyncChildThreadId,
            requestId: RuntimeRequestId.make("runtime-request:paused-wait-async-approval"),
            kind: "command",
            now,
          }),
        ],
      });

      const wakes = yield* awaitWake(threadId, afterSequence, "approval");
      assert.deepEqual(
        wakes.map((message) => message.notification?.source),
        [{ kind: "delegated_task", taskIds: [asyncTaskId], childThreadId: asyncChildThreadId }],
      );
    }),
  );

  it.effect("does not wake the parent for a request that was answered first", () =>
    Effect.gen(function* () {
      const sink = yield* EventSinkV2;
      const now = yield* DateTime.now;
      const answered = yield* seedParentWithAsyncChild("paused-answered", now);
      const pending = yield* seedParentWithAsyncChild("paused-pending", now);
      const answeredId = RuntimeRequestId.make("runtime-request:paused-answered-approval");
      const afterSequence = yield* sink.latestSequence();

      // One write, so the request is already resolved when its event is handled.
      yield* sink.write({
        events: [
          pendingRequest({
            childThreadId: answered.childThreadId,
            requestId: answeredId,
            kind: "command",
            now,
          }),
          pendingRequest({
            childThreadId: answered.childThreadId,
            requestId: answeredId,
            kind: "command",
            status: "resolved",
            now,
          }),
          pendingRequest({
            childThreadId: pending.childThreadId,
            requestId: RuntimeRequestId.make("runtime-request:paused-pending-approval"),
            kind: "command",
            now,
          }),
        ],
      });

      yield* awaitWake(pending.threadId, afterSequence, "approval");
      const orchestrator = yield* OrchestratorV2;
      const parent = yield* orchestrator.getThreadProjection(answered.threadId);
      assert.deepEqual(
        parent.messages.filter((message) => message.notification !== undefined),
        [],
      );
    }),
  );

  it.effect("wakes the parent on a later approval when the first wake could not be sent", () =>
    Effect.gen(function* () {
      const sink = yield* EventSinkV2;
      const now = yield* DateTime.now;
      const blocked = yield* seedParentWithAsyncChild("paused-retry", now);
      const witness = yield* seedParentWithAsyncChild("paused-retry-witness", now);
      const afterSequence = yield* sink.latestSequence();
      // A pending merge-back makes this parent reject queued messages.
      const mergeBack = {
        id: ContextTransferId.make("context-transfer:paused-retry-merge-back"),
        type: "merge_back" as const,
        sourceThreadId: witness.threadId,
        targetThreadId: blocked.threadId,
        sourcePoint: { threadId: witness.threadId },
        basePoint: null,
        sourceProviderInstanceId: null,
        targetProviderInstanceId: null,
        targetRunId: null,
        status: "pending" as const,
        resolution: null,
        createdBy: "user" as const,
        error: null,
        createdAt: now,
        updatedAt: now,
        consumedAt: null,
      };

      yield* sink.write({
        events: [
          {
            id: EventId.make("event:paused-retry-merge-back"),
            type: "context-transfer.created",
            threadId: blocked.threadId,
            occurredAt: now,
            payload: mergeBack,
          },
          pendingRequest({
            childThreadId: blocked.childThreadId,
            requestId: RuntimeRequestId.make("runtime-request:paused-retry-approval-1"),
            kind: "command",
            now,
          }),
          pendingRequest({
            childThreadId: witness.childThreadId,
            requestId: RuntimeRequestId.make("runtime-request:paused-retry-witness-approval"),
            kind: "command",
            now,
          }),
        ],
      });
      // The witness wake lands after the first approval was handled and rejected.
      yield* awaitWake(witness.threadId, afterSequence, "approval");
      const orchestrator = yield* OrchestratorV2;
      const rejected = yield* orchestrator.getThreadProjection(blocked.threadId);
      assert.deepEqual(
        rejected.messages.filter((message) => message.notification !== undefined),
        [],
      );

      yield* sink.write({
        events: [
          {
            id: EventId.make("event:paused-retry-merge-back-consumed"),
            type: "context-transfer.updated",
            threadId: blocked.threadId,
            occurredAt: now,
            payload: { ...mergeBack, status: "consumed" as const, consumedAt: now },
          },
          pendingRequest({
            childThreadId: blocked.childThreadId,
            requestId: RuntimeRequestId.make("runtime-request:paused-retry-approval-2"),
            kind: "command",
            now,
          }),
        ],
      });

      const wakes = yield* awaitWake(blocked.threadId, afterSequence, "approval");
      assert.deepEqual(
        wakes.map((message) => message.notification?.source),
        [
          {
            kind: "delegated_task",
            taskIds: [blocked.taskId],
            childThreadId: blocked.childThreadId,
          },
        ],
      );
    }),
  );
});
