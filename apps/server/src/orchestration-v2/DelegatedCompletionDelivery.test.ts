import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import * as TestClock from "effect/testing/TestClock";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { continueRestartedRun } from "./RestartContinuation.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import * as ProviderTurnStartServiceTestkit from "./ProviderTurnStartService.testkit.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";

const layerPlatformTest = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-orchestration-v2-delegated-completion-",
});

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;

const layerVcsDriverRegistryTest = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(layerServerConfig),
  Layer.provide(layerPlatformTest),
);

const layerCheckpointStoreTest = CheckpointStore.layer.pipe(
  Layer.provide(layerVcsDriverRegistryTest),
);

const driver = ProviderDriverKind.make("codex");
const orchestrationAdapter = {
  instanceId: modelSelection.instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("sessions are not used by delegated completion tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: {
    driverKind: driver,
    continuationKey: "codex:test",
  },
  displayName: "Codex test",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter,
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const layerTestProviderInstanceRegistry = Layer.succeed(
  ProviderInstanceRegistry.ProviderInstanceRegistry,
  {
    getInstance: (instanceId) =>
      Effect.succeed(instanceId === providerInstance.instanceId ? providerInstance : undefined),
    listInstances: Effect.succeed([providerInstance]),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.never,
  },
);

const layerTest = Layer.mergeAll(
  RuntimeLayer.layer,
  RuntimeLayer.layerEventSink,
  ProjectionStore.layer,
).pipe(
  Layer.provideMerge(RuntimeLayer.layerProjectService),
  Layer.provide(
    Layer.mock(WorkspacePaths.WorkspacePaths)({
      normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    }),
  ),
  Layer.provide(ProviderTurnStartServiceTestkit.layer),
  Layer.provide(
    Layer.succeed(ProjectEnrichmentService.ProjectEnrichmentService, {
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
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStoreTest),
  Layer.provide(layerServerConfig),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(layerTestProviderInstanceRegistry),
  Layer.provide(layerPlatformTest),
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
    const projects = yield* ProjectService.ProjectService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
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

it.layer(layerTest)("delegated completion delivery repairs", (it) => {
  it.effect("acceptance batches pending siblings without acknowledging their results", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
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

  it.effect("acceptance batches a settled_only sibling once its spawning run ended", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("mailbox-mixed");
      const runId = RunId.make("mailbox-mixed-parent");
      const taskId = NodeId.make("mailbox-mixed-always");
      const siblingId = NodeId.make("mailbox-mixed-settled-only");
      const messageId = MessageId.make(`message:delegated-delivery:${threadId}`);
      yield* seedParentWithTerminalTask({
        threadId,
        runId,
        projectId: ProjectId.make("mailbox-mixed-project"),
        rootNodeId: NodeId.make("mailbox-mixed-root"),
        taskId,
        deliveryState: "claimed",
        completionWake: "always",
        deliveryTaskIds: [taskId],
        now,
      });
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const task = projection.subagents[0]!;
      const spawningRun = projection.runs.find((row) => row.id === runId)!;
      yield* sink.write({
        events: [
          {
            ...runEvent({ threadId, runId, ordinal: 1, status: "cancelled", now }),
            payload: { ...spawningRun, status: "cancelled" as const, completedAt: now },
          },
          runEvent({
            threadId,
            runId: RunId.make("mailbox-mixed-continuation"),
            ordinal: 2,
            status: "running",
            now,
          }),
          {
            id: EventId.make("mailbox-mixed-message"),
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
          {
            id: EventId.make(`event:${siblingId}`),
            type: "subagent.updated" as const,
            threadId,
            runId,
            nodeId: siblingId,
            occurredAt: now,
            payload: {
              ...task,
              id: siblingId,
              completionWake: "settled_only" as const,
              completionDelivery: { state: "pending" as const, observedByRunId: null },
            },
          },
        ],
      });
      yield* orchestrator.dispatch({
        type: "notification.delivery.accept",
        commandId: CommandId.make("accept-mixed"),
        threadId,
        messageId,
      });
      const accepted = yield* orchestrator.getThreadProjection(threadId);
      const cohort = accepted.runs.find((row) => row.id === runId)?.delegatedCompletion;
      assert.deepEqual(cohort?.delivery?.taskIds, [siblingId]);
      assert.equal(
        accepted.subagents.find((row) => row.id === siblingId)?.completionDelivery?.state,
        "claimed",
      );
    }),
  );

  it.effect("builds completion text and metadata from the same live cohort", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
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
      const orchestrator = yield* Orchestrator.OrchestratorV2;
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
        const orchestrator = yield* Orchestrator.OrchestratorV2;
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

const traceSqlStatements = () => {
  const statements: Array<string> = [];
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        const query = span.attributes.get("db.query.text");
        if (typeof query === "string") statements.push(query);
      };
      return span;
    },
  });
  return { statements, tracer };
};

const reconcileCommandId = (name: string) => CommandId.make(`command:runtime-reconcile:${name}`);

const parentProviderThreadId = (threadId: ThreadId) =>
  ProviderThreadId.make(`provider-thread:${String(threadId).replace("thread:", "")}`);

const runEvent = (input: {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly ordinal: number;
  readonly status: OrchestrationV2Run["status"];
  readonly now: DateTime.Utc;
  readonly providerThreadId?: ProviderThreadId;
  readonly userMessageId?: MessageId;
  readonly delegatedCompletion?: OrchestrationV2Run["delegatedCompletion"];
}) => ({
  id: EventId.make(`event:${input.runId}:${input.status}`),
  type: "run.updated" as const,
  threadId: input.threadId,
  runId: input.runId,
  providerInstanceId: modelSelection.instanceId,
  occurredAt: input.now,
  payload: {
    id: input.runId,
    threadId: input.threadId,
    ordinal: input.ordinal,
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
    providerThreadId: input.providerThreadId ?? null,
    userMessageId: input.userMessageId ?? MessageId.make(`message:${input.runId}`),
    rootNodeId: null,
    activeAttemptId: null,
    status: input.status,
    requestedAt: input.now,
    startedAt: input.now,
    completedAt: input.status === "running" ? null : input.now,
    checkpointId: null,
    contextHandoffId: null,
    ...(input.delegatedCompletion === undefined
      ? {}
      : { delegatedCompletion: input.delegatedCompletion }),
  },
});

const seedRestartCancelledChild = (input: {
  readonly parentThreadId: ThreadId;
  readonly projectId: ProjectId;
  readonly parentRunId: RunId;
  readonly rootNodeId: NodeId;
  readonly name: string;
  readonly completionWake: "always" | "settled_only";
  readonly continuationPending: boolean;
  readonly runStatus?: "cancelled" | "completed";
  readonly lostWork?: OrchestrationV2Run["restartCancelledBackgroundWork"];
  readonly now: DateTime.Utc;
}) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const taskId = NodeId.make(`node:${input.name}`);
    const childThreadId = ThreadId.make(`thread:${input.name}`);
    const childRunId = RunId.make(`run:${input.name}:1`);
    yield* eventSink.write({
      commandId: CommandId.make(`command:seed-child:${input.name}`),
      events: [
        {
          id: EventId.make(`event:${input.name}:thread`),
          type: "thread.created",
          threadId: childThreadId,
          occurredAt: input.now,
          payload: {
            createdBy: "agent",
            creationSource: "server",
            id: childThreadId,
            projectId: input.projectId,
            title: input.name,
            providerInstanceId: modelSelection.instanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: {
              parentThreadId: input.parentThreadId,
              relationshipToParent: "subagent",
              rootThreadId: input.parentThreadId,
            },
            forkedFrom: { type: "node", nodeId: taskId },
            createdAt: input.now,
            updatedAt: input.now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        },
        {
          id: EventId.make(`event:${input.name}:task`),
          type: "subagent.updated",
          threadId: input.parentThreadId,
          runId: input.parentRunId,
          nodeId: taskId,
          driver,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: input.now,
          payload: {
            id: taskId,
            threadId: input.parentThreadId,
            runId: input.parentRunId,
            parentNodeId: input.rootNodeId,
            origin: "app_owned",
            createdBy: "agent",
            driver,
            providerInstanceId: modelSelection.instanceId,
            providerThreadId: null,
            childThreadId,
            nativeTaskRef: null,
            prompt: `Run ${input.name}.`,
            title: null,
            model: null,
            completionWake: input.completionWake,
            status: "running",
            result: null,
            startedAt: input.now,
            completedAt: null,
            updatedAt: input.now,
          },
        },
      ],
    });
    const childRun = runEvent({
      threadId: childThreadId,
      runId: childRunId,
      ordinal: 1,
      status: input.runStatus ?? "cancelled",
      now: input.now,
    });
    yield* eventSink.writeWithEffects({
      commandId: reconcileCommandId(input.name),
      events: [
        input.lostWork === undefined
          ? childRun
          : {
              ...childRun,
              payload: { ...childRun.payload, restartCancelledBackgroundWork: input.lostWork },
            },
      ],
      effects: input.continuationPending
        ? [
            {
              id: `effect:restart-continuation:${childRunId}`,
              commandId: reconcileCommandId(input.name),
              threadId: childThreadId,
              request: { type: "provider-runtime.continue", sourceRunId: childRunId },
            },
          ]
        : [],
    });
    return { taskId, childThreadId, childRunId };
  });

const seedRunningCompletionDelivery = (name: string) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make(`thread:settlement-retry:${name}`);
    const runId = RunId.make(`run:settlement-retry:${name}`);
    const taskId = NodeId.make(`node:settlement-retry:${name}`);
    const messageId = MessageId.make(`message:delegated-delivery:${threadId}`);
    const deliveryRunId = RunId.make(`${runId}:delivery`);
    yield* seedParentWithTerminalTask({
      threadId,
      runId,
      taskId,
      projectId: ProjectId.make(`project:settlement-retry:${name}`),
      rootNodeId: NodeId.make(`root:settlement-retry:${name}`),
      deliveryState: "claimed",
      completionWake: "always",
      deliveryTaskIds: [taskId],
      now,
    });
    const terminal = runEvent({
      threadId,
      runId: deliveryRunId,
      ordinal: 2,
      status: "cancelled",
      now,
      providerThreadId: parentProviderThreadId(threadId),
      userMessageId: messageId,
    });
    yield* sink.write({
      commandId: reconcileCommandId(`settlement-retry:${name}`),
      events: [
        {
          id: EventId.make(`event:settlement-retry:${name}:message`),
          type: "message.updated",
          threadId,
          runId: deliveryRunId,
          occurredAt: now,
          payload: {
            id: messageId,
            threadId,
            runId: deliveryRunId,
            nodeId: null,
            role: "user",
            text: "Delegated task finished.",
            attachments: [],
            streaming: false,
            createdBy: "agent",
            creationSource: "server",
            createdAt: now,
            updatedAt: now,
            delegatedCompletion: { parentRunId: runId, generation: 1, taskIds: [taskId] },
          },
        },
        { ...terminal, payload: { ...terminal.payload, status: "running", completedAt: null } },
      ],
    });
    return { threadId, runId, taskId, terminal, now };
  });

it.layer(Layer.merge(layerTest, ProviderContinuationRequests.layer))(
  "subagent follow-ups",
  (it) => {
    it.effect.each([
      { stage: "result", failures: 1 },
      { stage: "result", failures: 3 },
      { stage: "offer", failures: 1 },
      { stage: "offer", failures: 3 },
      { stage: "discovery", failures: 1 },
      { stage: "settlement", failures: 1 },
    ] as const)(
      "recovers terminal delivery after $failures $stage read failures",
      ({ stage, failures }) =>
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const eventSink = yield* EventSink.EventSinkV2;
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
          const now = yield* DateTime.now;
          const parentThreadId = ThreadId.make(`thread:transient-result-read:${stage}:${failures}`);
          const projectId = ProjectId.make(`project:transient-result-read:${stage}:${failures}`);
          const parentRunId = RunId.make(`run:transient-result-read:${stage}:${failures}`);
          const rootNodeId = NodeId.make(`node:transient-result-read:${stage}:${failures}`);
          yield* seedParentWithTerminalTask({
            threadId: parentThreadId,
            projectId,
            runId: parentRunId,
            rootNodeId,
            taskId: NodeId.make(`node:transient-result-read-settled:${stage}:${failures}`),
            deliveryState: "delivered",
            now,
          });
          const child = yield* seedRestartCancelledChild({
            parentThreadId,
            projectId,
            parentRunId,
            rootNodeId,
            name: `transient-result-read-child-${stage}:${failures}`,
            completionWake: "always",
            continuationPending: false,
            runStatus: "completed",
            now,
          });
          const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.find(
            (run) => run.id === parentRunId,
          )!;
          const nextTerminalEntered = yield* Deferred.make<void>();
          const backgroundRetryEntered = yield* Deferred.make<void>();
          const afterSequence = yield* eventSink.latestSequence();
          const readRecords = projections.getThreadRecords;
          const readMessage = projections.getRunMessage;
          const readThread = projections.getThread;
          const offersSpy = vi.spyOn(requests, "offer");
          let resultReads = 0;
          const failRead = Effect.suspend(() => {
            resultReads += 1;
            return resultReads <= failures
              ? Effect.fail(
                  new ProjectionStore.ProjectionStoreReadError({
                    threadId: child.childThreadId,
                    cause: new Error(`transient ${stage} projection failure`),
                  }),
                ).pipe(
                  Effect.tapError(() =>
                    resultReads === 3
                      ? Deferred.succeed(backgroundRetryEntered, undefined)
                      : Effect.void,
                  ),
                )
              : Effect.void;
          });
          const recordsSpy = vi
            .spyOn(projections, "getThreadRecords")
            .mockImplementation((...args) => {
              const target =
                stage === "result"
                  ? args[0] === child.childThreadId &&
                    args[1].length === 2 &&
                    args[1].includes("turnItems")
                  : stage === "offer" &&
                    args[0] === parentThreadId &&
                    args[1].length === 4 &&
                    args[1].includes("providerThreads") &&
                    args[1].includes("providerTurns");
              return target
                ? failRead.pipe(Effect.andThen(readRecords(...args)))
                : readRecords(...args);
            });
          const threadSpy = vi
            .spyOn(projections, "getThread")
            .mockImplementation((threadId) =>
              stage === "discovery" && threadId === child.childThreadId
                ? failRead.pipe(Effect.andThen(readThread(threadId)))
                : readThread(threadId),
            );
          const messageSpy = vi
            .spyOn(projections, "getRunMessage")
            .mockImplementation((threadId, runId) =>
              (stage === "settlement" && threadId === child.childThreadId
                ? failRead.pipe(Effect.andThen(readMessage(threadId, runId)))
                : readMessage(threadId, runId)
              ).pipe(
                Effect.tap(() =>
                  threadId === parentThreadId && runId === parentRunId
                    ? Deferred.succeed(nextTerminalEntered, undefined)
                    : Effect.void,
                ),
              ),
            );
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              recordsSpy.mockRestore();
              threadSpy.mockRestore();
              offersSpy.mockRestore();
              messageSpy.mockRestore();
            }),
          );
          yield* eventSink.write({
            commandId: CommandId.make(
              `command:transient-result-read:terminal:${stage}:${failures}`,
            ),
            events: [
              {
                ...runEvent({
                  threadId: child.childThreadId,
                  runId: child.childRunId,
                  ordinal: 1,
                  status: "completed",
                  now,
                }),
                id: EventId.make(`event:transient-result-read:child-terminal:${stage}:${failures}`),
              },
              {
                id: EventId.make(
                  `event:transient-result-read:parent-terminal:${stage}:${failures}`,
                ),
                type: "run.updated",
                threadId: parentThreadId,
                runId: parentRunId,
                occurredAt: now,
                payload: { ...parentRun, status: "completed", completedAt: now },
              },
            ],
          });
          // The terminal listener is serial. Entering the next event proves that
          // it finished handling the injected failure, without a timeout or poll.
          yield* Deferred.await(nextTerminalEntered);
          if (failures === 3) {
            yield* Deferred.await(backgroundRetryEntered);
            yield* TestClock.adjust("1 second");
            yield* eventSink.stream({ afterSequence, eventType: "context-transfer.created" }).pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "context-transfer.created" &&
                  stored.event.payload.sourceThreadId === child.childThreadId,
              ),
              Stream.take(1),
              Stream.runDrain,
            );
          }
          const published = yield* orchestrator.getThreadProjection(parentThreadId);
          const transfers = published.contextTransfers.filter(
            (transfer) =>
              transfer.type === "subagent_result" &&
              transfer.sourceThreadId === child.childThreadId,
          );
          assert.equal(transfers.length, 1);
          if (stage !== "offer") assert.isAtLeast(resultReads, 2);
          assert.equal(
            offersSpy.mock.calls.filter(([request]) => request.threadId === parentThreadId).length,
            1,
          );
          if (stage !== "offer") assert.equal(resultReads, failures + 1);
          assert.equal(
            published.subagents.find((task) => task.id === child.taskId)?.status,
            "completed",
          );
          const wake = yield* requests.take;
          assert.equal(wake.threadId, parentThreadId);
          assert.equal(wake.delegatedCompletion?.parentRunId, parentRunId);
          assert.equal(wake.delegatedCompletion?.generation, 2);
          yield* orchestrator.recoverDelegatedTask(child.childThreadId, child.childRunId);
          const replayed = yield* orchestrator.getThreadProjection(parentThreadId);
          assert.deepEqual(replayed.contextTransfers, published.contextTransfers);
          assert.deepEqual(
            replayed.runs.find((run) => run.id === parentRunId)?.delegatedCompletion,
            published.runs.find((run) => run.id === parentRunId)?.delegatedCompletion,
          );
          assert.equal(
            offersSpy.mock.calls.filter(([request]) => request.threadId === parentThreadId).length,
            1,
          );
        }),
    );

    it.effect("owns one retry worker per terminal run and releases ownership after recovery", () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
        const now = yield* DateTime.now;
        const parentThreadId = ThreadId.make("thread:retry-ownership");
        const projectId = ProjectId.make("project:retry-ownership");
        const parentRunId = RunId.make("run:retry-ownership");
        const rootNodeId = NodeId.make("node:retry-ownership");
        yield* seedParentWithTerminalTask({
          threadId: parentThreadId,
          projectId,
          runId: parentRunId,
          rootNodeId,
          taskId: NodeId.make("node:retry-ownership-settled"),
          deliveryState: "delivered",
          now,
        });
        const seedChild = (name: string) =>
          seedRestartCancelledChild({
            parentThreadId,
            projectId,
            parentRunId,
            rootNodeId,
            name,
            completionWake: "always",
            continuationPending: false,
            runStatus: "completed",
            now,
          });
        const child = yield* seedChild("retry-ownership-child");
        const sibling = yield* seedChild("retry-ownership-sibling");
        let phase: "result" | "discovery" = "result";
        let failing = true;
        let reads = 0;
        let nextTerminalEntered = yield* Deferred.make<void>();
        const backgroundEntered = yield* Deferred.make<void>();
        const failRead = Effect.suspend(() => {
          reads += 1;
          return (
            failing
              ? Effect.fail(
                  new ProjectionStore.ProjectionStoreReadError({ threadId: child.childThreadId }),
                )
              : Effect.void
          ).pipe(
            Effect.ensuring(
              reads === 3 ? Deferred.succeed(backgroundEntered, undefined) : Effect.void,
            ),
          );
        });
        const readRecords = projections.getThreadRecords;
        const readThread = projections.getThread;
        const readMessage = projections.getRunMessage;
        const recordsSpy = vi
          .spyOn(projections, "getThreadRecords")
          .mockImplementation((...args) =>
            phase === "result" &&
            args[0] === child.childThreadId &&
            args[1].length === 2 &&
            args[1].includes("turnItems")
              ? failRead.pipe(Effect.andThen(readRecords(...args)))
              : readRecords(...args),
          );
        const threadSpy = vi
          .spyOn(projections, "getThread")
          .mockImplementation((threadId) =>
            phase === "discovery" && threadId === child.childThreadId
              ? failRead.pipe(Effect.andThen(readThread(threadId)))
              : readThread(threadId),
          );
        const messageSpy = vi
          .spyOn(projections, "getRunMessage")
          .mockImplementation((threadId, runId) =>
            readMessage(threadId, runId).pipe(
              Effect.tap(() =>
                threadId === parentThreadId && runId === parentRunId
                  ? Deferred.succeed(nextTerminalEntered, undefined)
                  : Effect.void,
              ),
            ),
          );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            failing = false;
          }).pipe(
            Effect.andThen(TestClock.adjust("1 second")),
            Effect.andThen(
              Effect.sync(() => {
                recordsSpy.mockRestore();
                threadSpy.mockRestore();
                messageSpy.mockRestore();
              }),
            ),
          ),
        );
        const terminalEvent = (target: typeof child, suffix: string) => ({
          ...runEvent({
            threadId: target.childThreadId,
            runId: target.childRunId,
            ordinal: 1,
            status: "completed",
            now,
          }),
          id: EventId.make(`event:retry-ownership:${suffix}`),
        });
        const emitTerminal = (suffix: string) =>
          Effect.gen(function* () {
            const parent = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.find(
              (run) => run.id === parentRunId,
            )!;
            yield* eventSink.write({
              commandId: CommandId.make(`command:retry-ownership:${suffix}`),
              events: [
                terminalEvent(child, suffix),
                {
                  id: EventId.make(`event:retry-ownership:marker:${suffix}`),
                  type: "run.updated",
                  threadId: parentThreadId,
                  runId: parentRunId,
                  occurredAt: now,
                  payload: { ...parent, status: "completed", completedAt: now },
                },
              ],
            });
            yield* Deferred.await(nextTerminalEntered);
          });
        const awaitTransfer = (sourceThreadId: ThreadId, afterSequence: number) =>
          eventSink
            .stream({
              afterSequence,
              eventType: "context-transfer.created",
            })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "context-transfer.created" &&
                  stored.event.payload.sourceThreadId === sourceThreadId,
              ),
              Stream.take(1),
              Stream.runDrain,
            );
        yield* emitTerminal("initial");
        yield* Deferred.await(backgroundEntered);
        const afterSequence = yield* eventSink.latestSequence();
        yield* eventSink.write({
          commandId: CommandId.make("command:retry-ownership:duplicate"),
          events: [terminalEvent(child, "duplicate"), terminalEvent(sibling, "sibling")],
        });
        yield* awaitTransfer(sibling.childThreadId, afterSequence);
        yield* TestClock.adjust("0 seconds");
        const beforeTick = reads;
        yield* TestClock.adjust("1 second");
        assert.equal(reads - beforeTick, 1);
        failing = false;
        yield* TestClock.adjust("1 second");
        yield* awaitTransfer(child.childThreadId, afterSequence);
        const recovered = yield* orchestrator.getThreadProjection(parentThreadId);
        assert.equal(
          recovered.contextTransfers.filter(
            (transfer) =>
              transfer.type === "subagent_result" &&
              transfer.sourceThreadId === child.childThreadId,
          ).length,
          1,
        );
        assert.equal(
          recovered.contextTransfers.filter(
            (transfer) =>
              transfer.type === "subagent_result" &&
              transfer.sourceThreadId === sibling.childThreadId,
          ).length,
          1,
        );
        const siblingWake = yield* requests.take;
        const recoveredWake = yield* requests.take;
        assert.equal(siblingWake.delegatedCompletion?.generation, 2);
        assert.deepEqual(recoveredWake.delegatedCompletion, siblingWake.delegatedCompletion);

        // A later failure on the same child must acquire fresh worker ownership.
        phase = "discovery";
        failing = true;
        reads = 0;
        nextTerminalEntered = yield* Deferred.make<void>();
        yield* emitTerminal("after-recovery");
        yield* TestClock.adjust("0 seconds");
        assert.equal(reads, 3);
        failing = false;
        yield* TestClock.adjust("1 second");
        const laterWake = yield* requests.take;
        assert.deepEqual(laterWake.delegatedCompletion, recoveredWake.delegatedCompletion);
        const final = yield* orchestrator.getThreadProjection(parentThreadId);
        assert.deepEqual(final.contextTransfers, recovered.contextTransfers);
        assert.deepEqual(
          final.runs.find((run) => run.id === parentRunId)?.delegatedCompletion,
          recovered.runs.find((run) => run.id === parentRunId)?.delegatedCompletion,
        );
      }),
    );

    it.effect.each([0, 1, 3])(
      "offers the successor after %i postcommit settlement read failures",
      (failures) =>
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const sink = yield* EventSink.EventSinkV2;
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
          const { threadId, runId, taskId, terminal, now } = yield* seedRunningCompletionDelivery(
            `offer-${failures}`,
          );
          const markerRunId = RunId.make(`${runId}:marker`);
          let drained = yield* Deferred.make<void>();
          let offerReads = 0;
          const readRecords = projections.getThreadRecords;
          const readMessage = projections.getRunMessage;
          const offers = vi.spyOn(requests, "offer");
          const recordsSpy = vi
            .spyOn(projections, "getThreadRecords")
            .mockImplementation((...args) =>
              args[0] === threadId && args[1].length === 4 && args[1].includes("providerTurns")
                ? Effect.suspend(() =>
                    ++offerReads <= failures
                      ? Effect.fail(new ProjectionStore.ProjectionStoreReadError({ threadId }))
                      : readRecords(...args),
                  )
                : readRecords(...args),
            );
          const messageSpy = vi
            .spyOn(projections, "getRunMessage")
            .mockImplementation((tid, rid) =>
              readMessage(tid, rid).pipe(
                Effect.tap(() =>
                  rid === markerRunId ? Deferred.succeed(drained, undefined) : Effect.void,
                ),
              ),
            );
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              recordsSpy.mockRestore();
              messageSpy.mockRestore();
              offers.mockRestore();
            }),
          );
          const emit = (suffix: string) =>
            sink.write({
              events: [
                { ...terminal, id: EventId.make(`event:${runId}:terminal:${suffix}`) },
                {
                  ...runEvent({
                    threadId,
                    runId: markerRunId,
                    ordinal: 3,
                    status: "completed",
                    now,
                  }),
                  id: EventId.make(`event:${runId}:marker:${suffix}`),
                },
              ],
            });
          yield* emit("initial");
          yield* Deferred.await(drained);
          yield* TestClock.adjust("1 second");
          const published = yield* orchestrator.getThreadProjection(threadId);
          const cohort = published.runs.find((run) => run.id === runId)?.delegatedCompletion;
          assert.equal(cohort?.delivery?.generation, 2);
          assert.equal(
            offers.mock.calls.filter(([request]) => request.threadId === threadId).length,
            1,
          );
          assert.equal(offerReads, failures + 1);
          assert.equal(
            published.subagents.find((task) => task.id === taskId)?.completionDelivery?.state,
            "claimed",
          );
          const wake = yield* requests.take;
          assert.deepEqual(wake.delegatedCompletion, {
            parentRunId: runId,
            generation: 2,
            messageId: cohort?.delivery?.messageId,
          });
          drained = yield* Deferred.make<void>();
          yield* emit("replay");
          yield* Deferred.await(drained);
          const replayed = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(
            replayed.runs.find((run) => run.id === runId)?.delegatedCompletion,
            cohort,
          );
          assert.deepEqual(replayed.contextTransfers, published.contextTransfers);
          assert.equal(
            offers.mock.calls.filter(([request]) => request.threadId === threadId).length,
            1,
          );
        }),
    );

    it.effect("retains distinct terminal-run settlements on one thread", () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
        const { threadId, runId, terminal, now } =
          yield* seedRunningCompletionDelivery("distinct-runs");
        const parentRun = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.id === runId,
        )!;
        const markerRunId = RunId.make(`${runId}:marker`);
        const entered = yield* Deferred.make<void>();
        const drained = yield* Deferred.make<void>();
        let failing = true;
        let parentReads = 0;
        let deliveryReads = 0;
        const readMessage = projections.getRunMessage;
        const offers = vi.spyOn(requests, "offer");
        const messageSpy = vi.spyOn(projections, "getRunMessage").mockImplementation((tid, rid) =>
          Effect.suspend(() => {
            if (tid === threadId && (rid === runId || rid === terminal.payload.id)) {
              if (rid === runId) parentReads += 1;
              else deliveryReads += 1;
              if (failing)
                return Effect.fail(new ProjectionStore.ProjectionStoreReadError({ threadId })).pipe(
                  Effect.ensuring(
                    rid === runId && parentReads === 3
                      ? Deferred.succeed(entered, undefined)
                      : Effect.void,
                  ),
                );
            }
            return readMessage(tid, rid).pipe(
              Effect.tap(() =>
                rid === markerRunId ? Deferred.succeed(drained, undefined) : Effect.void,
              ),
            );
          }),
        );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            failing = false;
          }).pipe(
            Effect.andThen(TestClock.adjust("1 second")),
            Effect.andThen(
              Effect.sync(() => {
                messageSpy.mockRestore();
                offers.mockRestore();
              }),
            ),
          ),
        );
        yield* sink.write({
          events: [
            {
              ...runEvent({ threadId, runId, ordinal: 1, status: "completed", now }),
              payload: { ...parentRun, status: "completed", completedAt: now },
            },
          ],
        });
        yield* Deferred.await(entered);
        yield* sink.write({
          events: [
            { ...terminal, id: EventId.make(`event:${runId}:delivery-terminal`) },
            runEvent({ threadId, runId: markerRunId, ordinal: 3, status: "completed", now }),
          ],
        });
        yield* Deferred.await(drained);
        yield* TestClock.adjust("0 seconds");
        const beforeTick = { parentReads, deliveryReads };
        yield* TestClock.adjust("1 second");
        assert.equal(parentReads - beforeTick.parentReads, 1);
        assert.equal(deliveryReads - beforeTick.deliveryReads, 1);
        failing = false;
        yield* TestClock.adjust("1 second");
        const recovered = yield* orchestrator.getThreadProjection(threadId);
        const cohort = recovered.runs.find((run) => run.id === runId)?.delegatedCompletion;
        assert.equal(cohort?.delivery?.generation, 2);
        assert.equal(
          offers.mock.calls.filter(([request]) => request.threadId === threadId).length,
          1,
        );
        const wake = yield* requests.take;
        assert.equal(wake.delegatedCompletion?.generation, 2);
        assert.equal(wake.delegatedCompletion?.messageId, cohort?.delivery?.messageId);
      }),
    );

    it.effect.each([false, true])(
      "repairs a published result offer with an intervening follow-up: %s",
      (followup) =>
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const sink = yield* EventSink.EventSinkV2;
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
          const now = yield* DateTime.now;
          const parentThreadId = ThreadId.make(
            `thread:published-followup-retry:followup:${followup}`,
          );
          const parentRunId = RunId.make(`run:published-followup-retry:followup:${followup}`);
          const projectId = ProjectId.make(`project:published-followup-retry:followup:${followup}`);
          const rootNodeId = NodeId.make(`node:published-followup-retry:followup:${followup}`);
          yield* seedParentWithTerminalTask({
            threadId: parentThreadId,
            runId: parentRunId,
            projectId,
            rootNodeId,
            taskId: NodeId.make(`node:published-followup-retry:seed:${followup}`),
            deliveryState: "delivered",
            now,
          });
          const child = yield* seedRestartCancelledChild({
            parentThreadId,
            projectId,
            parentRunId,
            rootNodeId,
            name: `published-followup-retry-child-${followup}`,
            completionWake: "always",
            continuationPending: false,
            runStatus: "completed",
            now,
          });
          const markerRunId = RunId.make(`run:published-followup-retry:marker:${followup}`);
          const retryEntered = yield* Deferred.make<void>();
          const resumeRetry = yield* Deferred.make<void>();
          const drained = yield* Deferred.make<void>();
          const records = projections.getThreadRecords;
          const thread = projections.getThread;
          const message = projections.getRunMessage;
          let failedOffer = false;
          let heldRetry = false;
          const offers = vi.spyOn(requests, "offer");
          const recordsSpy = vi
            .spyOn(projections, "getThreadRecords")
            .mockImplementation((...args) =>
              args[0] === parentThreadId &&
              args[1].length === 4 &&
              args[1].includes("providerTurns")
                ? Effect.suspend(() => {
                    if (failedOffer) return records(...args);
                    failedOffer = true;
                    return Effect.fail(
                      new ProjectionStore.ProjectionStoreReadError({ threadId: parentThreadId }),
                    );
                  })
                : records(...args),
            );
          const threadSpy = vi.spyOn(projections, "getThread").mockImplementation((tid) =>
            Effect.suspend(() => {
              if (tid === child.childThreadId && failedOffer && !heldRetry) {
                heldRetry = true;
                return Deferred.succeed(retryEntered, undefined).pipe(
                  Effect.andThen(Deferred.await(resumeRetry)),
                  Effect.andThen(thread(tid)),
                );
              }
              return thread(tid);
            }),
          );
          const messageSpy = vi
            .spyOn(projections, "getRunMessage")
            .mockImplementation((tid, rid) =>
              message(tid, rid).pipe(
                Effect.tap(() =>
                  rid === markerRunId ? Deferred.succeed(drained, undefined) : Effect.void,
                ),
              ),
            );
          yield* Effect.addFinalizer(() =>
            Deferred.succeed(resumeRetry, undefined).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  recordsSpy.mockRestore();
                  threadSpy.mockRestore();
                  messageSpy.mockRestore();
                  offers.mockRestore();
                }),
              ),
            ),
          );
          yield* sink.write({
            events: [
              {
                ...runEvent({
                  threadId: child.childThreadId,
                  runId: child.childRunId,
                  ordinal: 1,
                  status: "completed",
                  now,
                }),
                id: EventId.make(`event:published-followup-retry:terminal:${followup}`),
              },
              runEvent({
                threadId: parentThreadId,
                runId: markerRunId,
                ordinal: 3,
                status: "completed",
                now,
              }),
            ],
          });
          yield* Deferred.await(retryEntered);
          const before = yield* orchestrator.getThreadProjection(parentThreadId);
          const cohortBefore = before.runs.find((r) => r.id === parentRunId)?.delegatedCompletion;
          assert.isNotNull(before.subagents.find((t) => t.id === child.taskId)?.result);
          assert.equal(cohortBefore?.delivery?.generation, 2);
          if (followup) {
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("command:published-followup-retry:real-followup"),
              threadId: child.childThreadId,
              messageId: MessageId.make("message:published-followup-retry:real-followup"),
              text: "Check the same work again.",
              attachments: [],
              dispatchMode: { type: "start_immediately" },
            });
            const childNow = yield* orchestrator.getThreadProjection(child.childThreadId);
            assert.isTrue(
              childNow.runs.some((r) => r.id !== child.childRunId && r.status === "starting"),
            );
            const parentNow = yield* orchestrator.getThreadProjection(parentThreadId);
            const childTasks = parentNow.subagents.filter(
              (t) => t.childThreadId === child.childThreadId,
            );
            assert.equal(childTasks.length, 2);
            const followupTask = childTasks.find((t) => t.id !== child.taskId);
            assert.isDefined(followupTask);
            assert.isNull(followupTask?.result);
          }
          yield* Deferred.succeed(resumeRetry, undefined);
          yield* Deferred.await(drained);
          yield* TestClock.adjust("3 seconds");
          const after = yield* orchestrator.getThreadProjection(parentThreadId);
          const cohortAfter = after.runs.find((r) => r.id === parentRunId)?.delegatedCompletion;
          const offerCount = offers.mock.calls.filter(
            ([r]) => r.threadId === parentThreadId,
          ).length;
          const original = after.subagents.find((t) => t.id === child.taskId);
          const transferCount = after.contextTransfers.filter(
            (t) => t.type === "subagent_result" && t.sourceThreadId === child.childThreadId,
          ).length;
          assert.equal(transferCount, 1);
          assert.deepEqual(after.contextTransfers, before.contextTransfers);
          assert.deepEqual(cohortAfter, cohortBefore);
          assert.equal(original?.completionDelivery?.state, "claimed");
          assert.equal(offerCount, 1);
          const wake = yield* requests.take;
          assert.equal(wake.delegatedCompletion?.messageId, cohortBefore?.delivery?.messageId);
          assert.equal(wake.delegatedCompletion?.generation, 2);
          assert.equal(wake.delegatedCompletion?.parentRunId, parentRunId);
        }),
    );

    it.effect("terminal acknowledgement cannot suppress an unpublished result wake", () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
        const now = yield* DateTime.now;
        const parentThreadId = ThreadId.make("thread:unpublished-observation");
        const projectId = ProjectId.make("project:unpublished-observation");
        const parentRunId = RunId.make("run:unpublished-observation");
        const rootNodeId = NodeId.make("node:unpublished-observation");
        yield* seedParentWithTerminalTask({
          threadId: parentThreadId,
          projectId,
          runId: parentRunId,
          rootNodeId,
          taskId: NodeId.make("node:unpublished-observation-settled"),
          deliveryState: "delivered",
          now,
        });
        // Reconciliation events do not trigger the live terminal listener.
        // Hold publication until the parent's terminal observation commits.
        const child = yield* seedRestartCancelledChild({
          parentThreadId,
          projectId,
          parentRunId,
          rootNodeId,
          name: "unpublished-child-observation",
          completionWake: "always",
          continuationPending: false,
          runStatus: "completed",
          now,
        });
        const publish = yield* Deferred.make<void>();
        const publication = yield* Deferred.await(publish).pipe(
          Effect.andThen(orchestrator.recoverDelegatedTask(child.childThreadId, child.childRunId)),
          Effect.forkChild,
        );
        const observe = (suffix: string) =>
          orchestrator.dispatch({
            type: "delegated_task.completion-delivery.acknowledge",
            commandId: CommandId.make(`command:unpublished-observation:${suffix}`),
            parentThreadId,
            taskId: child.taskId,
            observedByRunId: parentRunId,
          });
        yield* observe("before-publication");
        yield* Deferred.succeed(publish, undefined);
        yield* Fiber.join(publication);

        const published = yield* orchestrator.getThreadProjection(parentThreadId);
        assert.equal(
          published.contextTransfers.filter(
            (transfer) =>
              transfer.type === "subagent_result" &&
              transfer.sourceThreadId === child.childThreadId,
          ).length,
          1,
        );
        assert.equal(
          published.subagents.find((task) => task.id === child.taskId)?.completionDelivery?.state,
          "claimed",
        );
        const wake = yield* requests.take;
        assert.equal(wake.threadId, parentThreadId);
        assert.equal(wake.delegatedCompletion?.parentRunId, parentRunId);

        yield* observe("after-publication");
        const observed = yield* orchestrator.getThreadProjection(parentThreadId);
        assert.deepEqual(
          observed.subagents.find((task) => task.id === child.taskId)?.completionDelivery,
          { state: "acknowledged", observedByRunId: parentRunId },
        );
        assert.isNull(
          observed.runs.find((run) => run.id === parentRunId)?.delegatedCompletion?.delivery,
        );
      }),
    );

    const outcomes = [
      "completed",
      "failed",
      "interrupted",
      "restarted",
      "stopped",
      "overlapping",
    ] as const;
    it.effect.each(outcomes)(
      "delivers a %s follow-up independently of the original task",
      (outcome) =>
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const eventSink = yield* EventSink.EventSinkV2;
          const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
          const now = yield* DateTime.now;
          const parentThreadId = ThreadId.make(`thread:followup-${outcome}`);
          const projectId = ProjectId.make(`project:followup-${outcome}`);
          const parentRunId = RunId.make(`run:followup-${outcome}`);
          const rootNodeId = NodeId.make(`node:followup-${outcome}`);
          yield* seedParentWithTerminalTask({
            threadId: parentThreadId,
            projectId,
            runId: parentRunId,
            rootNodeId,
            taskId: NodeId.make(`node:seed-${outcome}`),
            deliveryState: "acknowledged",
            now,
          });
          const child = yield* seedRestartCancelledChild({
            parentThreadId,
            projectId,
            parentRunId,
            rootNodeId,
            name: `followup-child-${outcome}`,
            completionWake: "always",
            continuationPending: false,
            runStatus: "completed",
            now,
          });
          yield* orchestrator.recoverDelegatedTasks;
          let firstWake = yield* requests.take;
          while (firstWake.threadId !== parentThreadId) firstWake = yield* requests.take;
          assert.equal(firstWake.delegatedCompletion?.parentRunId, parentRunId);
          yield* orchestrator.dispatch({
            type: "delegated_task.completion-delivery.acknowledge",
            commandId: CommandId.make(`command:followup-ack-${outcome}`),
            parentThreadId,
            taskId: child.taskId,
            observedByRunId: parentRunId,
          });
          const original = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
            (task) => task.id === child.taskId,
          )!;
          const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.find(
            (run) => run.id === parentRunId,
          )!;
          yield* eventSink.write({
            commandId: reconcileCommandId(`followup-parent-finished-${outcome}`),
            events: [
              {
                id: EventId.make(`event:followup-parent-finished-${outcome}`),
                type: "run.updated",
                threadId: parentThreadId,
                runId: parentRunId,
                occurredAt: now,
                payload: { ...parentRun, status: "completed", completedAt: now },
              },
            ],
          });
          const messageId = MessageId.make(`message:followup-${outcome}`);
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: outcome === "failed" ? "user" : "agent",
            creationSource: outcome === "failed" ? "web" : "mcp",
            commandId: CommandId.make(`command:followup-send-${outcome}`),
            threadId: child.childThreadId,
            senderThreadId: parentThreadId,
            messageId,
            text: "Check the same work again.",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
          });
          const childProjection = yield* orchestrator.getThreadProjection(child.childThreadId);
          let run = childProjection.runs.find((row) => row.userMessageId === messageId)!;
          assert.isDefined(run.delegatedTaskId);
          const workingParent = yield* orchestrator.getShellSnapshot();
          const backgroundTask = workingParent.threads
            .find((thread) => thread.id === parentThreadId)
            ?.pendingBackgroundTasks?.find((task) => task.kind === "subagent");
          assert.equal(backgroundTask?.childThreadId, child.childThreadId);
          if (outcome === "overlapping") {
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "agent",
              creationSource: "mcp",
              commandId: CommandId.make("command:overlapping-followup"),
              threadId: child.childThreadId,
              senderThreadId: parentThreadId,
              messageId: MessageId.make("message:overlapping-followup"),
              text: "Keep working on another follow-up.",
              attachments: [],
              dispatchMode: { type: "queue_after_active" },
            });
          }
          if (outcome === "restarted") {
            const cut = { ...run, status: "cancelled" as const, startedAt: now, completedAt: now };
            yield* eventSink.writeWithEffects({
              commandId: reconcileCommandId("followup-restart-cut"),
              events: [
                {
                  id: EventId.make("event:followup-restart-cut"),
                  type: "run.updated",
                  threadId: child.childThreadId,
                  runId: run.id,
                  occurredAt: now,
                  payload: cut,
                },
              ],
              effects: [
                {
                  id: `effect:restart-continuation:${run.id}`,
                  commandId: reconcileCommandId("followup-restart-cut"),
                  threadId: child.childThreadId,
                  request: { type: "provider-runtime.continue", sourceRunId: run.id },
                },
              ],
            });
            yield* orchestrator.recoverDelegatedTasks;
            assert.isNull(
              (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
                (task) => task.id === run.delegatedTaskId,
              )!.result,
            );
            const continuationMessageId = MessageId.make("message:followup-restart-continuation");
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "agent",
              creationSource: "server",
              commandId: CommandId.make("command:followup-restart-continuation"),
              threadId: child.childThreadId,
              restartContinuationOfRunId: run.id,
              messageId: continuationMessageId,
              text: "Continue where you left off.",
              attachments: [],
              dispatchMode: { type: "start_immediately" },
            });
            const continuation = (yield* orchestrator.getThreadProjection(
              child.childThreadId,
            )).runs.find((row) => row.userMessageId === continuationMessageId)!;
            assert.equal(continuation.delegatedTaskId, run.delegatedTaskId);
            run = continuation;
          }
          if (outcome === "stopped") {
            yield* orchestrator.dispatch({
              type: "thread.stop",
              threadId: parentThreadId,
              commandId: CommandId.make(`command:followup-stop-${outcome}`),
            });
          }
          yield* eventSink.write({
            commandId: reconcileCommandId(`followup-finish-${outcome}`),
            events: [
              {
                id: EventId.make(`event:followup-finish-${outcome}`),
                type: "run.updated",
                threadId: child.childThreadId,
                runId: run.id,
                occurredAt: now,
                payload: {
                  ...run,
                  status:
                    outcome === "stopped"
                      ? "interrupted"
                      : outcome === "restarted" || outcome === "overlapping"
                        ? "completed"
                        : outcome,
                  startedAt: now,
                  completedAt: now,
                },
              },
            ],
          });
          yield* orchestrator.recoverDelegatedTasks;
          const finished = yield* orchestrator.getThreadProjection(parentThreadId);
          assert.deepEqual(
            finished.subagents.find((task) => task.id === child.taskId),
            original,
          );
          const followup = finished.subagents.find((task) => task.id === run.delegatedTaskId)!;
          if (outcome === "overlapping") {
            const later = finished.subagents.find(
              (task) =>
                task.childThreadId === child.childThreadId &&
                task.id !== child.taskId &&
                task.id !== followup.id,
            )!;
            assert.equal(later.status, "pending");
            assert.isNull(later.result);
          }
          assert.equal(
            followup.status,
            outcome === "stopped"
              ? "interrupted"
              : outcome === "restarted" || outcome === "overlapping"
                ? "completed"
                : outcome,
          );
          assert.equal(
            followup.completionDelivery?.state,
            outcome === "stopped" ? "disposed" : "claimed",
          );
          if (outcome !== "stopped") {
            let wake = yield* requests.take;
            while (
              wake.threadId !== parentThreadId ||
              wake.delegatedCompletion?.messageId === firstWake.delegatedCompletion?.messageId
            ) {
              wake = yield* requests.take;
            }
            assert.equal(wake.delegatedCompletion?.parentRunId, parentRunId);
            assert.notEqual(
              wake.delegatedCompletion?.messageId,
              firstWake.delegatedCompletion?.messageId,
            );
          }
          assert.equal(
            finished.contextTransfers.filter(
              (transfer) =>
                transfer.type === "subagent_result" &&
                transfer.sourceThreadId === child.childThreadId,
            ).length,
            2,
          );
          yield* orchestrator.recoverDelegatedTasks;
          const recovered = yield* orchestrator.getThreadProjection(parentThreadId);
          assert.equal(recovered.contextTransfers.length, finished.contextTransfers.length);
          if (outcome === "completed") {
            const automaticMessageId = MessageId.make("message:followup-automatic-wake");
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "agent",
              creationSource: "server",
              commandId: CommandId.make("command:followup-automatic-wake"),
              threadId: child.childThreadId,
              messageId: automaticMessageId,
              text: "A monitor reported new output.",
              attachments: [],
              notification: {
                source: { kind: "monitor" },
                outcome: "updated",
                summary: "Monitor updated",
              },
              dispatchMode: { type: "queue_after_active" },
            });
            const automatic = (yield* orchestrator.getThreadProjection(
              child.childThreadId,
            )).runs.find((run) => run.userMessageId === automaticMessageId)!;
            assert.isUndefined(automatic.delegatedTaskId);
            yield* eventSink.write({
              commandId: reconcileCommandId("followup-automatic-finished"),
              events: [
                {
                  id: EventId.make("event:followup-automatic-finished"),
                  type: "run.updated",
                  threadId: child.childThreadId,
                  runId: automatic.id,
                  occurredAt: now,
                  payload: { ...automatic, status: "completed", startedAt: now, completedAt: now },
                },
              ],
            });
            yield* orchestrator.recoverDelegatedTasks;
            const afterAutomatic = yield* orchestrator.getThreadProjection(parentThreadId);
            assert.deepEqual(afterAutomatic.subagents, recovered.subagents);
            assert.equal(afterAutomatic.contextTransfers.length, recovered.contextTransfers.length);
            const control = yield* seedRestartCancelledChild({
              parentThreadId,
              projectId,
              parentRunId,
              rootNodeId,
              name: "followup-control-child",
              completionWake: "always",
              continuationPending: false,
              runStatus: "completed",
              now,
            });
            yield* orchestrator.recoverDelegatedTasks;
            const afterControl = yield* orchestrator.getThreadProjection(parentThreadId);
            assert.equal(
              afterControl.subagents.find((task) => task.id === control.taskId)?.completionDelivery
                ?.state,
              "claimed",
            );
            assert.equal(
              afterControl.contextTransfers.filter(
                (transfer) =>
                  transfer.type === "subagent_result" &&
                  transfer.sourceThreadId === control.childThreadId,
              ).length,
              1,
            );
          }
        }),
    );
  },
);

it.layer(layerTest)("delegated tasks across a server restart", (it) => {
  it.effect("holds a restart-cancelled child for its continuation's result", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:restart-parent");
      const projectId = ProjectId.make("project:restart-parent");
      const runId = RunId.make("run:restart-parent");
      const rootNodeId = NodeId.make("node:restart-parent-root");
      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId: NodeId.make("node:restart-parent-settled"),
        deliveryState: "delivered",
        now,
      });
      const child = (
        name: string,
        continuationPending: boolean,
        runStatus?: "cancelled" | "completed",
      ) =>
        seedRestartCancelledChild({
          parentThreadId: threadId,
          projectId,
          parentRunId: runId,
          rootNodeId,
          name,
          completionWake: "always",
          continuationPending,
          ...(runStatus === undefined ? {} : { runStatus }),
          now,
        });
      const resumed = yield* child("restart-resumed-child", true);
      const stopped = yield* child("restart-stopped-child", false);
      const backgrounded = yield* child("restart-backgrounded-child", true, "completed");
      const recut = yield* child("restart-recut-child", false);
      const recutContinuationId = RunId.make("run:restart-recut-child:2");
      const recutCommandId = CommandId.make("command:restart-recut-child:reconcile");
      const recutRun = runEvent({
        threadId: recut.childThreadId,
        runId: recutContinuationId,
        ordinal: 2,
        status: "cancelled",
        now,
      });
      yield* eventSink.writeWithEffects({
        commandId: recutCommandId,
        events: [
          {
            ...recutRun,
            payload: {
              ...recutRun.payload,
              startedAt: null,
              restartContinuationOfRunId: recut.childRunId,
            },
          },
        ],
        effects: [
          {
            id: `effect:restart-continuation:${recutContinuationId}`,
            commandId: recutCommandId,
            threadId: recut.childThreadId,
            request: { type: "provider-runtime.continue", sourceRunId: recutContinuationId },
          },
        ],
      });

      yield* orchestrator.recoverDelegatedTasks;

      const recovered = yield* orchestrator.getThreadProjection(threadId);
      const task = (id: NodeId) => recovered.subagents.find((row) => row.id === id);
      assert.equal(task(stopped.taskId)?.status, "cancelled");
      assert.equal(task(stopped.taskId)?.completionDelivery?.state, "claimed");
      assert.equal(task(resumed.taskId)?.status, "running");
      assert.isNull(task(resumed.taskId)?.result ?? null);
      assert.equal(task(backgrounded.taskId)?.status, "running");
      assert.isNull(task(backgrounded.taskId)?.result ?? null);
      assert.equal(task(recut.taskId)?.status, "running");
      assert.isTrue(yield* orchestrator.delegatedTaskResultPending(recut.childThreadId));
      assert.isTrue(yield* orchestrator.delegatedTaskResultPending(resumed.childThreadId));
      assert.isFalse(yield* orchestrator.delegatedTaskResultPending(stopped.childThreadId));
      yield* orchestrator.recoverDelegatedTask(recut.childThreadId, recut.childRunId);
      const replayed = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(replayed.subagents.find((row) => row.id === recut.taskId)?.status, "running");
      yield* eventSink.write({
        commandId: CommandId.make("command:restart-stopped-child:resumed"),
        events: [
          runEvent({
            threadId: stopped.childThreadId,
            runId: RunId.make("run:restart-stopped-child:2"),
            ordinal: 2,
            status: "running",
            now,
          }),
        ],
      });
      assert.isTrue(yield* orchestrator.delegatedTaskResultPending(stopped.childThreadId));
      assert.isFalse(
        recovered.contextTransfers.some(
          (transfer) => transfer.sourceThreadId === resumed.childThreadId,
        ),
      );

      const afterSequence = yield* eventSink.latestSequence();
      const continuationRunId = RunId.make("run:restart-resumed-child:2");
      yield* eventSink.write({
        commandId: CommandId.make("command:restart-resumed-child:completed"),
        events: [
          {
            id: EventId.make("event:restart-resumed-child:result"),
            type: "message.updated",
            threadId: resumed.childThreadId,
            runId: continuationRunId,
            occurredAt: now,
            payload: {
              id: MessageId.make("message:restart-resumed-child:result"),
              threadId: resumed.childThreadId,
              runId: continuationRunId,
              nodeId: null,
              role: "assistant",
              text: "Finished after the restart.",
              attachments: [],
              streaming: false,
              createdBy: "agent",
              creationSource: "server",
              createdAt: now,
              updatedAt: now,
            },
          },
          runEvent({
            threadId: resumed.childThreadId,
            runId: continuationRunId,
            ordinal: 2,
            status: "completed",
            now,
          }),
        ],
      });
      const settled = yield* eventSink
        .stream({ afterSequence, eventType: "subagent.updated" })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "subagent.updated" &&
              stored.event.payload.id === resumed.taskId,
          ),
          Stream.take(1),
          Stream.runHead,
        );
      assert.isTrue(settled._tag === "Some");
      const finished = yield* orchestrator.getThreadProjection(threadId);
      const finishedTask = finished.subagents.find((row) => row.id === resumed.taskId);
      assert.equal(finishedTask?.status, "completed");
      assert.equal(finishedTask?.result, "Finished after the restart.");
    }),
  );

  it.effect("settles a restart-cancelled child whose continuation declines to start", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:restart-declined-parent");
      const projectId = ProjectId.make("project:restart-declined-parent");
      const runId = RunId.make("run:restart-declined-parent");
      const rootNodeId = NodeId.make("node:restart-declined-parent-root");
      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId: NodeId.make("node:restart-declined-parent-settled"),
        deliveryState: "delivered",
        now,
      });
      const child = yield* seedRestartCancelledChild({
        parentThreadId: threadId,
        projectId,
        parentRunId: runId,
        rootNodeId,
        name: "restart-declined-child",
        completionWake: "always",
        continuationPending: true,
        now,
      });
      yield* orchestrator.recoverDelegatedTasks;
      const held = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(held.subagents.find((row) => row.id === child.taskId)?.status, "running");

      yield* continueRestartedRun({
        threadId: child.childThreadId,
        sourceRunId: child.childRunId,
      }).pipe(
        Effect.provide(ServerSettings.layerTest({ continueThreadsAfterServerUpdate: false })),
      );

      const settled = yield* orchestrator.getThreadProjection(threadId);
      const task = settled.subagents.find((row) => row.id === child.taskId);
      assert.equal(task?.status, "cancelled");
      assert.equal(task?.completionDelivery?.state, "claimed");
    }),
  );

  it.effect("reports a child whose monitor the restart cut as interrupted, not completed", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:restart-monitor-parent");
      const projectId = ProjectId.make("project:restart-monitor-parent");
      const runId = RunId.make("run:restart-monitor-parent");
      const rootNodeId = NodeId.make("node:restart-monitor-parent-root");
      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId: NodeId.make("node:restart-monitor-parent-settled"),
        deliveryState: "delivered",
        now,
      });
      const child = yield* seedRestartCancelledChild({
        parentThreadId: threadId,
        projectId,
        parentRunId: runId,
        rootNodeId,
        name: "restart-monitor-child",
        completionWake: "always",
        continuationPending: true,
        runStatus: "completed",
        lostWork: [{ kind: "monitor", label: "Gate attempt 9" }],
        now,
      });
      yield* orchestrator.recoverDelegatedTasks;
      const held = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(held.subagents.find((row) => row.id === child.taskId)?.status, "running");

      yield* continueRestartedRun({
        threadId: child.childThreadId,
        sourceRunId: child.childRunId,
      }).pipe(
        Effect.provide(ServerSettings.layerTest({ continueThreadsAfterServerUpdate: false })),
      );

      const settled = yield* orchestrator.getThreadProjection(threadId);
      const task = settled.subagents.find((row) => row.id === child.taskId);
      assert.equal(task?.status, "interrupted");
      assert.equal(task?.result, "Child task ended with status interrupted.");
      assert.equal(task?.completionDelivery?.state, "claimed");
    }),
  );

  // A running provider turn does not prove the provider consumed the delivery
  // (Claude marks the turn running before it reads the prompt), so a cut
  // delivery is offered again even when a continuation resumes that turn.
  it.effect("re-offers a cut delivery even when a continuation resumes its turn", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const seed = (name: string, continuationPending: boolean) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make(`thread:${name}`);
          const runId = RunId.make(`run:${name}`);
          const taskId = NodeId.make(`node:${name}-task`);
          const messageId = MessageId.make(`message:delegated-delivery:${threadId}`);
          const deliveryRunId = RunId.make(`run:${name}:delivery`);
          yield* seedParentWithTerminalTask({
            threadId,
            projectId: ProjectId.make(`project:${name}`),
            runId,
            rootNodeId: NodeId.make(`node:${name}-root`),
            taskId,
            deliveryState: "claimed",
            completionWake: "always",
            deliveryTaskIds: [taskId],
            now,
          });
          yield* eventSink.writeWithEffects({
            commandId: reconcileCommandId(name),
            events: [
              {
                id: EventId.make(`event:${name}:delivery-message`),
                type: "message.updated",
                threadId,
                runId: deliveryRunId,
                occurredAt: now,
                payload: {
                  id: messageId,
                  threadId,
                  runId: deliveryRunId,
                  nodeId: null,
                  role: "user",
                  text: `Delegated task ${taskId} reached a terminal state.`,
                  attachments: [],
                  streaming: false,
                  createdBy: "agent",
                  creationSource: "server",
                  createdAt: now,
                  updatedAt: now,
                  delegatedCompletion: { parentRunId: runId, generation: 1, taskIds: [taskId] },
                },
              },
              runEvent({
                threadId,
                runId: deliveryRunId,
                ordinal: 2,
                status: "cancelled",
                now,
                providerThreadId: parentProviderThreadId(threadId),
                userMessageId: messageId,
              }),
            ],
            effects: continuationPending
              ? [
                  {
                    id: `effect:restart-continuation:${deliveryRunId}`,
                    commandId: reconcileCommandId(name),
                    threadId,
                    request: { type: "provider-runtime.continue", sourceRunId: deliveryRunId },
                  },
                ]
              : [],
          });
          return { threadId, runId, taskId };
        });
      const cut = yield* seed("delivery-cut", false);
      const resumed = yield* seed("delivery-resumed", true);

      yield* orchestrator.recoverDelegatedTasks;

      for (const seeded of [cut, resumed]) {
        const projection = yield* orchestrator.getThreadProjection(seeded.threadId);
        assert.deepEqual(
          projection.subagents.find((row) => row.id === seeded.taskId)?.completionDelivery?.state,
          "claimed",
        );
        const delivery = projection.runs.find((row) => row.id === seeded.runId)?.delegatedCompletion
          ?.delivery;
        assert.equal(delivery?.generation, 2);
        assert.deepEqual(delivery?.taskIds, [seeded.taskId]);
      }
    }),
  );

  it.effect("settles only the current delivery of a parent with long delivery history", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:delivery-history");
      const runId = RunId.make("run:delivery-history");
      const taskId = NodeId.make("node:delivery-history-task");
      const currentMessageId = MessageId.make(`message:delegated-delivery:${threadId}`);
      const currentRunId = RunId.make("run:delivery-history:current");
      const HISTORY = 40;
      yield* seedParentWithTerminalTask({
        threadId,
        projectId: ProjectId.make("project:delivery-history"),
        runId,
        rootNodeId: NodeId.make("node:delivery-history-root"),
        taskId,
        deliveryState: "claimed",
        completionWake: "always",
        deliveryTaskIds: [taskId],
        now,
      });
      const deliveryMessage = (id: MessageId, deliveryRunId: RunId) => ({
        id: EventId.make(`event:${deliveryRunId}:message`),
        type: "message.updated" as const,
        threadId,
        runId: deliveryRunId,
        occurredAt: now,
        payload: {
          id,
          threadId,
          runId: deliveryRunId,
          nodeId: null,
          role: "user" as const,
          text: `Delegated task ${taskId} reached a terminal state.`,
          attachments: [],
          streaming: false,
          createdBy: "agent" as const,
          creationSource: "server" as const,
          createdAt: now,
          updatedAt: now,
          delegatedCompletion: { parentRunId: runId, generation: 1, taskIds: [taskId] },
        },
      });
      const history = Array.from({ length: HISTORY }, (_, index) => {
        const historyRunId = RunId.make(`run:delivery-history:${index}`);
        const messageId = MessageId.make(`message:delivery-history:${index}`);
        return [
          deliveryMessage(messageId, historyRunId),
          runEvent({
            threadId,
            runId: historyRunId,
            ordinal: index + 2,
            status: "completed",
            now,
            providerThreadId: parentProviderThreadId(threadId),
            userMessageId: messageId,
          }),
        ];
      }).flat();
      yield* eventSink.write({
        commandId: reconcileCommandId("delivery-history"),
        events: [
          ...history,
          deliveryMessage(currentMessageId, currentRunId),
          runEvent({
            threadId,
            runId: currentRunId,
            ordinal: HISTORY + 2,
            status: "completed",
            now,
            providerThreadId: parentProviderThreadId(threadId),
            userMessageId: currentMessageId,
          }),
        ],
      });

      const { statements, tracer } = traceSqlStatements();
      yield* orchestrator.recoverDelegatedTasks.pipe(Effect.withTracer(tracer));

      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(
        projection.subagents.find((row) => row.id === taskId)?.completionDelivery?.state,
        "delivered",
      );
      assert.isNull(projection.runs.find((row) => row.id === runId)?.delegatedCompletion?.delivery);
      assert.lengthOf(
        statements.filter((statement) =>
          statement.includes("FROM orchestration_v2_projection_messages AS message"),
        ),
        1,
      );

      yield* orchestrator.recoverDelegatedTasks;
      const again = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(again.runs, projection.runs);
      assert.deepEqual(again.subagents, projection.subagents);
    }),
  );

  it.effect("settles a cancelled child whose held wakes wait behind it", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:held-wake-parent");
      const projectId = ProjectId.make("project:held-wake-parent");
      const runId = RunId.make("run:held-wake-parent");
      const rootNodeId = NodeId.make("node:held-wake-parent-root");
      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId: NodeId.make("node:held-wake-parent-settled"),
        deliveryState: "delivered",
        now,
      });
      const child = yield* seedRestartCancelledChild({
        parentThreadId: threadId,
        projectId,
        parentRunId: runId,
        rootNodeId,
        name: "held-wake-child",
        completionWake: "always",
        continuationPending: false,
        now,
      });
      const held = runEvent({
        threadId: child.childThreadId,
        runId: RunId.make("run:held-wake-child:2"),
        ordinal: 2,
        status: "queued",
        now,
      });
      yield* eventSink.write({
        commandId: CommandId.make("command:held-wake-child:held"),
        events: [
          {
            ...held,
            payload: { ...held.payload, startedAt: null, completedAt: null, queueHeld: true },
          },
        ],
      });

      yield* orchestrator.recoverDelegatedTasks;

      const recovered = yield* orchestrator.getThreadProjection(threadId);
      const task = recovered.subagents.find((row) => row.id === child.taskId);
      assert.equal(task?.status, "cancelled");
      assert.isNotNull(task?.result ?? null);
      assert.isTrue(
        recovered.contextTransfers.some(
          (transfer) =>
            transfer.type === "subagent_result" && transfer.sourceThreadId === child.childThreadId,
        ),
      );
      assert.isFalse(yield* orchestrator.delegatedTaskResultPending(child.childThreadId));
      const childProjection = yield* orchestrator.getThreadProjection(child.childThreadId);
      assert.deepEqual(
        childProjection.runs.map((run) => [run.status, run.queueHeld ?? false]),
        [
          ["cancelled", false],
          ["queued", true],
        ],
      );
    }),
  );

  it.effect("settles a child whose provider failure holds its queued wakes", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:failed-hold-parent");
      const projectId = ProjectId.make("project:failed-hold-parent");
      const runId = RunId.make("run:failed-hold-parent");
      const rootNodeId = NodeId.make("node:failed-hold-parent-root");
      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId: NodeId.make("node:failed-hold-parent-settled"),
        deliveryState: "delivered",
        now,
      });
      const child = yield* seedRestartCancelledChild({
        parentThreadId: threadId,
        projectId,
        parentRunId: runId,
        rootNodeId,
        name: "failed-hold-child",
        completionWake: "always",
        continuationPending: false,
        now,
      });
      const activeRun = runEvent({
        threadId: child.childThreadId,
        runId: RunId.make("run:failed-hold-child:2"),
        ordinal: 2,
        status: "running",
        now,
      });
      const queued = runEvent({
        threadId: child.childThreadId,
        runId: RunId.make("run:failed-hold-child:3"),
        ordinal: 3,
        status: "queued",
        now,
      });
      yield* eventSink.write({
        commandId: CommandId.make("command:failed-hold-child:resumed"),
        events: [
          activeRun,
          { ...queued, payload: { ...queued.payload, startedAt: null, completedAt: null } },
        ],
      });
      const afterSequence = yield* eventSink.latestSequence();
      const errorItemId = TurnItemId.make("turn-item:failed-hold-child:error");
      yield* eventSink.write({
        commandId: CommandId.make("command:failed-hold-child:failed"),
        events: [
          {
            id: EventId.make("event:failed-hold-child:error"),
            type: "turn-item.updated",
            threadId: child.childThreadId,
            runId: activeRun.runId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: {
              id: errorItemId,
              type: "error",
              threadId: child.childThreadId,
              runId: activeRun.runId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              status: "failed",
              title: "Provider failure",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              failure: {
                class: "provider_error",
                message: "Provider failed.",
                code: "provider_failed",
                retryable: null,
              },
            },
          },
          {
            ...activeRun,
            id: EventId.make("event:failed-hold-child:failed"),
            payload: { ...activeRun.payload, status: "failed", completedAt: now },
          },
        ],
      });

      const settled = yield* eventSink
        .stream({ afterSequence, eventType: "subagent.updated" })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "subagent.updated" && stored.event.payload.id === child.taskId,
          ),
          Stream.take(1),
          Stream.runHead,
        );
      assert.isTrue(settled._tag === "Some");
      const recovered = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(recovered.subagents.find((row) => row.id === child.taskId)?.status, "failed");
      const childProjection = yield* orchestrator.getThreadProjection(child.childThreadId);
      assert.deepEqual(
        childProjection.runs.map((run) => [run.status, run.queueHeld ?? false]),
        [
          ["cancelled", false],
          ["failed", false],
          ["queued", true],
        ],
      );
    }),
  );

  it.effect("wakes the parent for a settled_only task once its spawning turn ended", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:settled-only-restart");
      const projectId = ProjectId.make("project:settled-only-restart");
      const runId = RunId.make("run:settled-only-restart");
      const rootNodeId = NodeId.make("node:settled-only-restart-root");
      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId: NodeId.make("node:settled-only-restart-settled"),
        deliveryState: "delivered",
        now,
      });
      yield* eventSink.write({
        commandId: reconcileCommandId("settled-only-restart"),
        events: [
          runEvent({
            threadId,
            runId,
            ordinal: 1,
            status: "cancelled",
            now,
            providerThreadId: parentProviderThreadId(threadId),
            userMessageId: MessageId.make(`message:seed-user:${threadId}`),
            delegatedCompletion: { disposition: "open", nextGeneration: 2, delivery: null },
          }),
          runEvent({
            threadId,
            runId: RunId.make("run:settled-only-restart:continuation"),
            ordinal: 2,
            status: "running",
            now,
            providerThreadId: parentProviderThreadId(threadId),
          }),
        ],
      });
      const child = yield* seedRestartCancelledChild({
        parentThreadId: threadId,
        projectId,
        parentRunId: runId,
        rootNodeId,
        name: "settled-only-restart-child",
        completionWake: "settled_only",
        continuationPending: false,
        now,
      });

      yield* orchestrator.recoverDelegatedTasks;

      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(
        projection.subagents.find((row) => row.id === child.taskId)?.completionDelivery?.state,
        "claimed",
      );
      assert.deepEqual(
        projection.runs.find((row) => row.id === runId)?.delegatedCompletion?.delivery?.taskIds,
        [child.taskId],
      );
    }),
  );
});
