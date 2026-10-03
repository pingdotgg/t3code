import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Run,
  type OrchestrationV2AppThread,
  TurnItemId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  RunAttemptId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderRuntimeRecoveryService from "./ProviderRuntimeRecoveryService.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import {
  OrchestrationV2EventSinkLayerLive,
  OrchestrationV2LayerLive,
  ProjectServiceLayerLive,
} from "./runtimeLayer.ts";
import { worktreeRepairDependenciesTestLayer } from "./ProviderTurnStartService.testkit.ts";

const PlatformTestLayer = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
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

const TestProviderInstanceRegistry = Layer.succeed(
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

const OrchestrationTestLayer = Layer.mergeAll(
  OrchestrationV2LayerLive,
  OrchestrationV2EventSinkLayerLive,
).pipe(
  Layer.provideMerge(ProjectServiceLayerLive),
  Layer.provide(
    Layer.mock(WorkspacePaths.WorkspacePaths)({
      normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    }),
  ),
  Layer.provide(worktreeRepairDependenciesTestLayer),
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
  Layer.provide(CheckpointStoreTestLayer),
  Layer.provide(ServerConfigLayer),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(TestProviderInstanceRegistry),
  Layer.provide(PlatformTestLayer),
);

const TestLayer = OrchestrationTestLayer.pipe(Layer.provide(SqlitePersistenceMemory));

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

const seedCancellationCohort = Effect.fn(function* (
  name: string,
  mode: "starting" | "missing_attempt" | "terminal",
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make(`thread:bounded-cancel:${name}`);
  const originalRunId = RunId.make(`run:bounded-cancel:${name}:original`);
  yield* seedParentWithTerminalTask({
    threadId,
    runId: originalRunId,
    projectId: ProjectId.make(`project:bounded-cancel:${name}`),
    rootNodeId: NodeId.make(`node:bounded-cancel:${name}:original`),
    taskId: NodeId.make(`node:bounded-cancel:${name}:task`),
    deliveryState: "disposed",
    now,
  });
  const original = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
  const rootNodeId = NodeId.make(`node:bounded-cancel:${name}:promoted`);
  const providerThreadId = ProviderThreadId.make(`provider-thread:bounded-cancel:${name}`);
  const attemptId = RunAttemptId.make(`attempt:bounded-cancel:${name}:promoted`);
  const promoted: OrchestrationV2Run = {
    ...original,
    id: RunId.make(`run:bounded-cancel:${name}:promoted`),
    ordinal: 2,
    rootNodeId,
    providerThreadId,
    activeAttemptId: attemptId,
    userMessageId: MessageId.make(`message:bounded-cancel:${name}:promoted`),
    status: mode === "terminal" ? "completed" : "starting",
    completedAt: mode === "terminal" ? now : null,
    delegatedCompletion: undefined,
  };
  const queued: OrchestrationV2Run = {
    ...promoted,
    id: RunId.make(`run:bounded-cancel:${name}:queued`),
    ordinal: 3,
    rootNodeId: null,
    providerThreadId: null,
    activeAttemptId: null,
    userMessageId: MessageId.make(`message:bounded-cancel:${name}:queued`),
    status: mode === "terminal" ? "cancelled" : "queued",
    queueHeld: true,
    startedAt: null,
    completedAt: mode === "terminal" ? now : null,
  };
  yield* sink.write({
    events: [
      {
        id: EventId.make(`event:${threadId}:original-finished`),
        type: "run.updated",
        threadId,
        runId: originalRunId,
        occurredAt: now,
        payload: { ...original, status: "completed", completedAt: now },
      },
      {
        id: EventId.make(`event:${threadId}:provider`),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: {
          ...(yield* orchestrator.getThreadProjection(threadId)).providerThreads[0]!,
          id: providerThreadId,
          ownerNodeId: rootNodeId,
          providerSessionId: null,
          nativeThreadRef: { driver, nativeId: `native:${providerThreadId}`, strength: "strong" },
        },
      },
      {
        id: EventId.make(`event:${threadId}:node`),
        type: "node.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: rootNodeId,
          threadId,
          runId: promoted.id,
          parentNodeId: null,
          rootNodeId,
          kind: "root_turn",
          status: "running",
          countsForRun: true,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: null,
        },
      },
      ...(mode === "missing_attempt"
        ? []
        : [
            {
              id: EventId.make(`event:${threadId}:attempt`),
              type: "run-attempt.updated" as const,
              threadId,
              runId: promoted.id,
              occurredAt: now,
              payload: {
                id: attemptId,
                runId: promoted.id,
                attemptOrdinal: 1,
                rootNodeId,
                providerInstanceId: modelSelection.instanceId,
                providerThreadId,
                providerTurnId: null,
                reason: "initial" as const,
                status: "pending" as const,
                startedAt: null,
                completedAt: null,
              },
            },
          ]),
      ...[promoted, queued].map((payload) => ({
        id: EventId.make(`event:${payload.id}`),
        type: "run.created" as const,
        threadId,
        runId: payload.id,
        occurredAt: now,
        payload,
      })),
    ],
  });
  return { threadId, originalRunId, promoted, queued, attemptId, rootNodeId, now };
});

it.layer(TestLayer)("delegated completion delivery repairs", (it) => {
  it.effect(
    "keeps an older held continuation pending after later terminal runs and tracks resumed work",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread:held-child-parent");
        const childThreadId = ThreadId.make("thread:held-child");
        const taskId = NodeId.make("node:held-child-task");
        const parentRunId = RunId.make("run:held-child-parent");
        const rootNodeId = NodeId.make("node:held-child-parent-root");
        const projectId = ProjectId.make("project:held-child");
        yield* seedParentWithTerminalTask({
          threadId,
          projectId,
          runId: parentRunId,
          rootNodeId,
          taskId,
          deliveryState: "disposed",
          now,
        });
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("command:held-child-create"),
          threadId: childThreadId,
          projectId,
          title: "Held continuation",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "agent",
          creationSource: "mcp",
        });
        const parent = yield* orchestrator.getThreadProjection(threadId);
        const child = yield* orchestrator.getThreadProjection(childThreadId);
        const task = {
          ...parent.subagents[0]!,
          childThreadId,
          status: "running" as const,
          result: null,
          completedAt: null,
          completionDelivery: undefined,
        };
        const makeRun = (
          ordinal: number,
          status: OrchestrationV2Run["status"],
        ): OrchestrationV2Run => ({
          ...parent.runs[0]!,
          id: RunId.make(`run:held-child:${ordinal}`),
          threadId: childThreadId,
          ordinal,
          providerThreadId: null,
          rootNodeId: null,
          activeAttemptId: null,
          userMessageId: MessageId.make(`message:held-child:${ordinal}`),
          status,
          startedAt: status === "queued" ? null : now,
          completedAt: status === "queued" ? null : now,
          queueHeld: status === "queued",
          delegatedCompletion: undefined,
        });
        const runs = [
          makeRun(1, "failed"),
          makeRun(2, "queued"),
          makeRun(3, "completed"),
          makeRun(4, "completed"),
        ];
        const afterSequence = yield* sink.latestSequence();
        yield* sink.write({
          events: [
            {
              id: EventId.make("event:held-child-link"),
              type: "thread.metadata-updated",
              threadId: childThreadId,
              occurredAt: now,
              payload: {
                ...child.thread,
                lineage: {
                  parentThreadId: threadId,
                  relationshipToParent: "subagent",
                  rootThreadId: threadId,
                },
                forkedFrom: { type: "node", nodeId: taskId },
              },
            },
            {
              id: EventId.make("event:held-child-task"),
              type: "subagent.updated",
              threadId,
              occurredAt: now,
              payload: task,
            },
            {
              id: EventId.make("event:held-child-node"),
              type: "node.updated",
              threadId,
              occurredAt: now,
              payload: {
                id: taskId,
                threadId,
                runId: parentRunId,
                parentNodeId: rootNodeId,
                rootNodeId,
                kind: "subagent",
                status: "running",
                countsForRun: false,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                runtimeRequestId: null,
                checkpointScopeId: null,
                startedAt: now,
                completedAt: null,
              },
            },
            {
              id: EventId.make("event:held-child-item"),
              type: "turn-item.updated",
              threadId,
              occurredAt: now,
              payload: {
                id: TurnItemId.make("item:held-child"),
                threadId,
                runId: parentRunId,
                nodeId: taskId,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 1,
                status: "running",
                title: null,
                startedAt: now,
                completedAt: null,
                updatedAt: now,
                type: "subagent",
                subagentId: taskId,
                prompt: task.prompt,
                origin: "app_owned",
                driver,
                providerInstanceId: modelSelection.instanceId,
                childThreadId,
                result: null,
              },
            },
            ...runs.map((run) => ({
              id: EventId.make(`event:${run.id}`),
              type: "run.updated" as const,
              threadId: childThreadId,
              runId: run.id,
              occurredAt: now,
              payload: run,
            })),
            {
              id: EventId.make("event:held-child-final-result"),
              type: "message.updated",
              threadId: childThreadId,
              occurredAt: now,
              payload: {
                id: MessageId.make("message:held-child-result"),
                threadId: childThreadId,
                runId: runs[3]!.id,
                nodeId: null,
                role: "assistant",
                createdBy: "agent",
                creationSource: "provider",
                text: "Latest completed result",
                attachments: [],
                streaming: false,
                createdAt: now,
                updatedAt: now,
              },
            },
          ],
        });
        const awaitTaskStatus = (sequence: number, status: "pending" | "running" | "completed") =>
          sink.stream({ afterSequence: sequence, eventType: "subagent.updated" }).pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "subagent.updated" &&
                stored.event.payload.id === taskId &&
                stored.event.payload.status === status,
            ),
            Stream.take(1),
            Stream.runDrain,
          );
        yield* awaitTaskStatus(afterSequence, "pending");
        const pending = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(pending.subagents[0]?.status, "pending");
        assert.isNull(pending.subagents[0]?.result);
        assert.equal(pending.nodes.find((node) => node.id === taskId)?.status, "pending");
        assert.equal(pending.turnItems.find((item) => item.type === "subagent")?.status, "pending");
        assert.isFalse(
          pending.contextTransfers.some((transfer) => transfer.type === "subagent_result"),
        );
        const held = yield* orchestrator.getThreadProjection(childThreadId);
        assert.equal(held.runs.find((run) => run.id === runs[1]!.id)?.status, "queued");
        assert.isTrue(held.runs.find((run) => run.id === runs[1]!.id)?.queueHeld);
        assert.lengthOf(held.runs, 4);
        assert.equal(
          held.messages.find((message) => message.role === "assistant")?.text,
          "Latest completed result",
        );

        // A real resumed run must restore Running even when later ordinals
        // already hold completed history. Recovery never performs this resume.
        const beforeResume = yield* sink.latestSequence();
        yield* sink.write({
          events: [
            {
              id: EventId.make("event:held-child-resumed"),
              type: "run.updated",
              threadId: childThreadId,
              runId: runs[1]!.id,
              occurredAt: now,
              payload: {
                ...runs[1]!,
                status: "running",
                queueHeld: false,
                startedAt: now,
                completedAt: null,
              },
            },
          ],
        });
        yield* awaitTaskStatus(beforeResume, "running");
        const running = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(running.subagents[0]?.status, "running");
        assert.equal(running.nodes.find((node) => node.id === taskId)?.status, "running");
        assert.equal(running.turnItems.find((item) => item.type === "subagent")?.status, "running");
        assert.isNull(running.subagents[0]?.result);
        const beforeComplete = yield* sink.latestSequence();
        yield* sink.write({
          events: [
            {
              id: EventId.make("event:held-child-resume-completed"),
              type: "run.updated",
              threadId: childThreadId,
              runId: runs[1]!.id,
              occurredAt: now,
              payload: {
                ...runs[1]!,
                status: "completed",
                queueHeld: false,
                startedAt: now,
                completedAt: now,
              },
            },
          ],
        });
        yield* awaitTaskStatus(beforeComplete, "completed");
        const completed = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(completed.subagents[0]?.result, "Latest completed result");
        assert.lengthOf(
          completed.contextTransfers.filter((transfer) => transfer.type === "subagent_result"),
          1,
        );

        const siblingThreadId = ThreadId.make("thread:held-child-live-sibling");
        const siblingTaskId = NodeId.make("node:held-child-live-sibling");
        const beforeFollowup = yield* sink.latestSequence();
        const followup = makeRun(5, "queued");
        yield* sink.write({
          events: [
            {
              id: EventId.make("event:held-child-new-followup"),
              type: "run.created",
              threadId: childThreadId,
              runId: followup.id,
              occurredAt: now,
              payload: followup,
            },
            {
              id: EventId.make("event:held-child-live-sibling"),
              type: "thread.created",
              threadId: siblingThreadId,
              occurredAt: now,
              payload: {
                ...child.thread,
                id: siblingThreadId,
                lineage: {
                  parentThreadId: threadId,
                  relationshipToParent: "subagent",
                  rootThreadId: threadId,
                },
                forkedFrom: { type: "node", nodeId: siblingTaskId },
              },
            },
            {
              id: EventId.make("event:held-child-live-sibling-task"),
              type: "subagent.updated",
              threadId,
              occurredAt: now,
              payload: {
                ...task,
                id: siblingTaskId,
                childThreadId: siblingThreadId,
                status: "pending",
              },
            },
            {
              id: EventId.make("event:held-child-live-sibling-run"),
              type: "run.created",
              threadId: siblingThreadId,
              occurredAt: now,
              payload: {
                ...makeRun(1, "running"),
                id: RunId.make("run:held-child-live-sibling"),
                threadId: siblingThreadId,
                completedAt: null,
              },
            },
          ],
        });
        // The same created-run stream processes the follow-up before this live
        // sibling's receipt. The published result must remain terminal.
        yield* sink.stream({ afterSequence: beforeFollowup, eventType: "subagent.updated" }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "subagent.updated" &&
              stored.event.payload.id === siblingTaskId &&
              stored.event.payload.status === "running",
          ),
          Stream.take(1),
          Stream.runDrain,
        );
        const afterFollowup = yield* orchestrator.getThreadProjection(threadId);
        const published = afterFollowup.subagents.find((candidate) => candidate.id === taskId);
        assert.equal(published?.status, "completed");
        assert.equal(published?.result, "Latest completed result");
        assert.equal(
          afterFollowup.subagents.find((candidate) => candidate.id === siblingTaskId)?.status,
          "running",
        );
        assert.lengthOf(
          afterFollowup.contextTransfers.filter((transfer) => transfer.type === "subagent_result"),
          1,
        );
        const childAfterFollowup = yield* orchestrator.getThreadProjection(childThreadId);
        assert.equal(
          childAfterFollowup.runs.find((run) => run.id === followup.id)?.status,
          "queued",
        );
        assert.isTrue(childAfterFollowup.runs.find((run) => run.id === followup.id)?.queueHeld);
      }),
  );

  it.effect("cancels a queued cohort atomically without promoting its unheld sibling", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:atomic-queue-cancel");
      const runId = RunId.make("run:atomic-queue-parent");
      yield* seedParentWithTerminalTask({
        threadId,
        runId,
        projectId: ProjectId.make("project:atomic-queue-cancel"),
        rootNodeId: NodeId.make("node:atomic-queue-parent"),
        taskId: NodeId.make("node:atomic-queue-task"),
        deliveryState: "disposed",
        now,
      });
      const original = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
      const queued = [2, 3, 4].map((ordinal): OrchestrationV2Run => ({
        ...original,
        id: RunId.make(`run:atomic-queue:${ordinal}`),
        ordinal,
        rootNodeId: null,
        providerThreadId: null,
        activeAttemptId: null,
        userMessageId: MessageId.make(`message:atomic-queue:${ordinal}`),
        status: "queued",
        queueHeld: ordinal !== 3,
        startedAt: null,
        completedAt: null,
        delegatedCompletion: undefined,
      }));
      yield* sink.write({
        events: [
          ...queued.map((run) => ({
            id: EventId.make(`event:${run.id}`),
            type: "run.created" as const,
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: run,
          })),
          {
            id: EventId.make("event:atomic-parent-finished"),
            type: "run.updated",
            threadId,
            runId,
            occurredAt: now,
            payload: { ...original, status: "completed", completedAt: now },
          },
        ],
      });
      const receipt = yield* orchestrator.dispatch({
        type: "thread.runs.cancel",
        commandId: CommandId.make("command:atomic-queue-cancel"),
        threadId,
        runIds: [queued[0]!.id, queued[1]!.id, queued[0]!.id],
      });
      const cancelled = receipt.storedEvents.filter(
        (stored) =>
          stored.event.type === "run.updated" && stored.event.payload.status === "cancelled",
      );
      assert.lengthOf(cancelled, 2);
      assert.deepEqual(
        new Set(cancelled.map((stored) => stored.event.runId)),
        new Set([queued[0]!.id, queued[1]!.id]),
      );
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(after.runs.find((run) => run.id === queued[0]!.id)?.status, "cancelled");
      assert.equal(after.runs.find((run) => run.id === queued[1]!.id)?.status, "cancelled");
      const untouched = after.runs.find((run) => run.id === queued[2]!.id);
      assert.equal(untouched?.status, "queued");
      assert.isTrue(untouched?.queueHeld);
      assert.equal(untouched?.userMessageId, queued[2]!.userMessageId);
      assert.isFalse(
        after.runs.some((run) => ["preparing", "starting", "running"].includes(run.status)),
      );
      assert.isTrue(
        queued.every(
          (run) =>
            after.runs.find((candidate) => candidate.id === run.id)?.activeAttemptId === null,
        ),
      );
    }),
  );

  it.effect("cancels the bounded task cohort after a queued child promotes to Starting", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const cohort = yield* seedCancellationCohort("promoted", "starting");
      const receipt = yield* orchestrator.dispatch({
        type: "thread.runs.cancel",
        commandId: CommandId.make("command:bounded-cancel:promoted"),
        threadId: cohort.threadId,
        runIds: [cohort.originalRunId, cohort.promoted.id, cohort.queued.id],
        reason: "Cancel selected delegated task work",
      });
      const after = yield* orchestrator.getThreadProjection(cohort.threadId);
      assert.equal(after.runs.find((run) => run.id === cohort.originalRunId)?.status, "completed");
      assert.equal(after.runs.find((run) => run.id === cohort.promoted.id)?.status, "interrupted");
      assert.equal(after.runs.find((run) => run.id === cohort.queued.id)?.status, "cancelled");
      assert.equal(
        after.attempts.find((attempt) => attempt.id === cohort.attemptId)?.status,
        "interrupted",
      );
      assert.equal(
        after.nodes.find((node) => node.id === cohort.rootNodeId)?.status,
        "interrupted",
      );
      assert.isTrue(
        receipt.storedEvents.some(
          (stored) =>
            stored.event.type === "turn-item.updated" &&
            stored.event.payload.type === "run_interrupt_result" &&
            stored.event.payload.status === "interrupted",
        ),
      );
      assert.lengthOf(after.providerSessions, 0);
      assert.isFalse(
        after.runs.some((run) =>
          ["preparing", "starting", "running", "queued"].includes(run.status),
        ),
      );
    }),
  );

  it.effect(
    "records terminal cancellation as a no-op and never sweeps later input on receipt replay",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const cohort = yield* seedCancellationCohort("terminal", "terminal");
        const command = {
          type: "thread.runs.cancel" as const,
          commandId: CommandId.make("command:bounded-cancel:terminal"),
          threadId: cohort.threadId,
          runIds: [cohort.originalRunId, cohort.promoted.id, cohort.queued.id],
        };
        const first = yield* orchestrator.dispatch(command);
        assert.lengthOf(first.storedEvents, 0);
        const late: OrchestrationV2Run = {
          ...cohort.queued,
          id: RunId.make("run:bounded-cancel:terminal:later"),
          ordinal: 4,
          userMessageId: MessageId.make("message:bounded-cancel:terminal:later"),
          status: "queued",
          completedAt: null,
        };
        yield* sink.write({
          events: [
            {
              id: EventId.make("event:bounded-cancel:terminal:later-run"),
              type: "run.created",
              threadId: cohort.threadId,
              runId: late.id,
              occurredAt: cohort.now,
              payload: late,
            },
            {
              id: EventId.make("event:bounded-cancel:terminal:later-message"),
              type: "message.updated",
              threadId: cohort.threadId,
              occurredAt: cohort.now,
              payload: {
                id: late.userMessageId,
                threadId: cohort.threadId,
                runId: late.id,
                nodeId: null,
                createdBy: "user",
                creationSource: "web",
                role: "user",
                text: "New work after the cancellation",
                attachments: [],
                streaming: false,
                createdAt: cohort.now,
                updatedAt: cohort.now,
              },
            },
          ],
        });
        const replay = yield* orchestrator.dispatch(command);
        assert.equal(replay.sequence, first.sequence);
        assert.lengthOf(replay.storedEvents, 0);
        const after = yield* orchestrator.getThreadProjection(cohort.threadId);
        assert.equal(after.runs.find((run) => run.id === late.id)?.status, "queued");
        assert.equal(
          after.messages.find((message) => message.id === late.userMessageId)?.text,
          "New work after the cancellation",
        );
      }),
  );

  it.effect.each(["unknown", "missing_attempt"] as const)(
    "rejects the entire cancellation cohort for $0 without partially cancelling queued work",
    (failure) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const cohort = yield* seedCancellationCohort(
          failure,
          failure === "unknown" ? "starting" : "missing_attempt",
        );
        const selected = [cohort.queued.id, cohort.promoted.id];
        if (failure === "unknown") selected.push(RunId.make("run:bounded-cancel:missing"));
        const result = yield* orchestrator
          .dispatch({
            type: "thread.runs.cancel",
            commandId: CommandId.make(`command:bounded-cancel:${failure}`),
            threadId: cohort.threadId,
            runIds: selected,
          })
          .pipe(Effect.exit);
        assert.equal(result._tag, "Failure");
        const after = yield* orchestrator.getThreadProjection(cohort.threadId);
        assert.equal(after.runs.find((run) => run.id === cohort.promoted.id)?.status, "starting");
        assert.equal(after.runs.find((run) => run.id === cohort.queued.id)?.status, "queued");
        assert.isTrue(after.runs.find((run) => run.id === cohort.queued.id)?.queueHeld);
        assert.isFalse(
          after.turnItems.some(
            (item) => item.type === "run_interrupt_request" || item.type === "run_interrupt_result",
          ),
        );
      }),
  );

  it.effect("keeps public queued-run cancellation strict when its selected run has completed", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const cohort = yield* seedCancellationCohort("public-strict", "terminal");
      const result = yield* orchestrator
        .dispatch({
          type: "queued-run.cancel",
          commandId: CommandId.make("command:bounded-cancel:public-strict"),
          threadId: cohort.threadId,
          runId: cohort.originalRunId,
        })
        .pipe(Effect.exit);
      assert.equal(result._tag, "Failure");
      const after = yield* orchestrator.getThreadProjection(cohort.threadId);
      assert.equal(after.runs.find((run) => run.id === cohort.originalRunId)?.status, "completed");
    }),
  );

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

it.effect.each([
  {
    heldQueue: true,
    name: "repairs a persisted Running task with held older input during startup without replaying it",
  },
  {
    heldQueue: false,
    name: "publishes the recovered terminal result of an active child without queued work",
  },
])("$name", ({ heldQueue }) => {
  const parentId = ThreadId.make("thread:startup-queue-parent");
  const childId = ThreadId.make("thread:startup-queue-child");
  const taskId = NodeId.make("node:startup-queue-task");
  const parentRunId = RunId.make("run:startup-queue-parent");
  const rootNodeId = NodeId.make("node:startup-queue-parent");
  const seed = Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const thread = (id: ThreadId): OrchestrationV2AppThread => ({
      id,
      projectId: ProjectId.make("project:startup-queue"),
      title: "Persisted held queue",
      createdBy: "agent",
      creationSource: "mcp",
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: parentId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    });
    const run = (ordinal: number, status: OrchestrationV2Run["status"]): OrchestrationV2Run => ({
      id: RunId.make(`run:startup-queue:${ordinal}`),
      threadId: childId,
      ordinal,
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make(`message:startup-queue:${ordinal}`),
      rootNodeId: null,
      activeAttemptId: null,
      status,
      requestedAt: now,
      startedAt: status === "queued" ? null : now,
      completedAt: status === "queued" || status === "running" ? null : now,
      queueHeld: status === "queued",
      checkpointId: null,
      contextHandoffId: null,
    });
    yield* sink.write({
      events: [
        {
          id: EventId.make("event:startup-queue-parent"),
          type: "thread.created",
          threadId: parentId,
          occurredAt: now,
          payload: thread(parentId),
        },
        {
          id: EventId.make("event:startup-queue-child"),
          type: "thread.created",
          threadId: childId,
          occurredAt: now,
          payload: {
            ...thread(childId),
            lineage: {
              parentThreadId: parentId,
              relationshipToParent: "subagent",
              rootThreadId: parentId,
            },
            forkedFrom: { type: "node", nodeId: taskId },
          },
        },
        {
          id: EventId.make("event:startup-queue-parent-run"),
          type: "run.updated",
          threadId: parentId,
          runId: parentRunId,
          occurredAt: now,
          payload: { ...run(1, "completed"), id: parentRunId, threadId: parentId, rootNodeId },
        },
        {
          id: EventId.make("event:startup-queue-node"),
          type: "node.updated",
          threadId: parentId,
          occurredAt: now,
          payload: {
            id: taskId,
            threadId: parentId,
            runId: parentRunId,
            parentNodeId: rootNodeId,
            rootNodeId,
            kind: "subagent",
            status: "running",
            countsForRun: false,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: null,
          },
        },
        {
          id: EventId.make("event:startup-queue-item"),
          type: "turn-item.updated",
          threadId: parentId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make("item:startup-queue-task"),
            threadId: parentId,
            runId: parentRunId,
            nodeId: taskId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status: "running",
            title: null,
            startedAt: now,
            completedAt: null,
            updatedAt: now,
            type: "subagent",
            subagentId: taskId,
            origin: "app_owned",
            driver,
            providerInstanceId: modelSelection.instanceId,
            childThreadId: childId,
            prompt: "Held continuation",
            result: null,
          },
        },
        {
          id: EventId.make("event:startup-queue-task"),
          type: "subagent.updated",
          threadId: parentId,
          occurredAt: now,
          payload: {
            id: taskId,
            threadId: parentId,
            runId: parentRunId,
            parentNodeId: NodeId.make("node:startup-queue-parent"),
            origin: "app_owned",
            createdBy: "agent",
            driver,
            providerInstanceId: modelSelection.instanceId,
            providerThreadId: null,
            childThreadId: childId,
            nativeTaskRef: null,
            prompt: "Held continuation",
            title: null,
            model: null,
            status: "running",
            result: null,
            startedAt: now,
            completedAt: null,
            updatedAt: now,
          },
        },
        ...(heldQueue
          ? [run(1, "failed"), run(2, "queued"), run(3, "completed"), run(4, "completed")]
          : [run(1, "failed"), run(2, "running")]
        ).map((payload) => ({
          id: EventId.make(`event:${payload.id}`),
          type: "run.updated" as const,
          threadId: childId,
          runId: payload.id,
          occurredAt: now,
          payload,
        })),
        {
          id: EventId.make("event:startup-queue-message"),
          type: "message.updated",
          threadId: childId,
          occurredAt: now,
          payload: {
            id: MessageId.make("message:startup-queue:2"),
            threadId: childId,
            runId: RunId.make("run:startup-queue:2"),
            nodeId: null,
            role: "user",
            createdBy: "agent",
            creationSource: "mcp",
            text: "Keep this genuine queued continuation",
            attachments: [],
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        },
      ],
    });
  });
  const seededPersistence = Layer.effectDiscard(seed).pipe(
    Layer.provideMerge(
      OrchestrationV2EventSinkLayerLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    ),
  );
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const beforeRuntimeRecovery = yield* orchestrator.getThreadProjection(parentId);
    assert.equal(beforeRuntimeRecovery.subagents[0]?.status, heldQueue ? "pending" : "running");
    const sink = yield* EventSink.EventSinkV2;
    const afterSequence = yield* sink.latestSequence();
    const runtimeRecovery = yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService;
    yield* runtimeRecovery.recover;
    if (!heldQueue) {
      yield* sink.stream({ afterSequence, eventType: "subagent.updated" }).pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "subagent.updated" &&
            stored.event.payload.id === taskId &&
            stored.event.payload.status === "cancelled",
        ),
        Stream.take(1),
        Stream.runDrain,
      );
    }
    const parent = yield* orchestrator.getThreadProjection(parentId);
    const child = yield* orchestrator.getThreadProjection(childId);
    if (heldQueue) {
      assert.equal(parent.subagents[0]?.status, "pending");
      assert.equal(parent.nodes.find((node) => node.id === taskId)?.status, "pending");
      assert.equal(parent.turnItems.find((item) => item.type === "subagent")?.status, "pending");
      assert.isNull(parent.subagents[0]?.result);
      assert.isFalse(
        parent.contextTransfers.some((transfer) => transfer.type === "subagent_result"),
      );
      const queued = child.runs.find((candidate) => candidate.ordinal === 2);
      assert.equal(queued?.status, "queued");
      assert.isTrue(queued?.queueHeld);
      assert.isNull(queued?.activeAttemptId);
      assert.isNull(queued?.providerThreadId);
      assert.equal(
        child.messages.find((message) => message.runId === queued?.id)?.text,
        "Keep this genuine queued continuation",
      );
      assert.lengthOf(child.runs, 4);
      assert.isFalse(
        child.runs.some((candidate) =>
          ["preparing", "starting", "running"].includes(candidate.status),
        ),
      );
    } else {
      assert.equal(parent.subagents[0]?.status, "cancelled");
      assert.equal(parent.nodes.find((node) => node.id === taskId)?.status, "cancelled");
      assert.equal(parent.turnItems.find((item) => item.type === "subagent")?.status, "cancelled");
      assert.equal(parent.subagents[0]?.result, "Child task ended with status cancelled.");
      assert.lengthOf(
        parent.contextTransfers.filter((transfer) => transfer.type === "subagent_result"),
        1,
      );
      assert.equal(child.runs.find((candidate) => candidate.ordinal === 2)?.status, "cancelled");
      assert.lengthOf(child.runs, 2);
      assert.isFalse(
        child.runs.some((candidate) =>
          ["preparing", "starting", "running", "queued"].includes(candidate.status),
        ),
      );
    }
  }).pipe(Effect.provide(OrchestrationTestLayer.pipe(Layer.provide(seededPersistence))));
});
