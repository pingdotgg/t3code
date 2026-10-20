import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  CommandId,
  ContextTransferId,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderTurnId,
  RuntimeRequestId,
  ScheduledTaskId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as EventStore from "./EventStore.ts";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import { CLAUDE_PROVIDER } from "./Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import { DispatchModeLimit } from "./DispatchModeLimit.ts";
import { OrchestrationEffectRequestV2 } from "./EffectOutbox.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const fileDatabase = (dbPath: string) =>
  SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer));
const makeLayerTest = (
  layerDatabase: ReturnType<typeof fileDatabase> = SqlitePersistence.layerMemory,
) =>
  ThreadManagementService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        layerDatabase,
        ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
        EventStore.layer.pipe(Layer.provide(layerDatabase)),
        EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
        ProviderReplayHarness.layerWithRegistry(
          { name: "thread-stop" },
          ProviderAdapterRegistry.layerFromAdapters([adapter]),
          { databaseLayer: layerDatabase, runEffectWorker: false },
        ),
      ),
    ),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
  );
const layerTest = makeLayerTest();

const layerMcp = (layerDatabase: ReturnType<typeof fileDatabase>) =>
  OrchestratorMcpService.layer.pipe(
    Layer.provideMerge(makeLayerTest(layerDatabase)),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(ProviderAdapterRegistry.layerFromAdapters([adapter])),
    Layer.provide(Layer.mock(ThreadLaunch.ThreadLaunchService)({})),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
    Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
    Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
    Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
  );

const encodeEffectRequest = Schema.encodeSync(Schema.fromJsonString(OrchestrationEffectRequestV2));

const pullRequest = (number: number) => ({
  host: "github.com",
  repository: "pingdotgg/t3code",
  number,
});

const createWatchingThread = (threadId: ThreadId, number: number) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:thread-stop"),
      title: threadId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* watch(threadId, number);
  });

const watch = (threadId: ThreadId, number: number) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.pull-request.watch",
      commandId: CommandId.make(`watch:${threadId}:${number}`),
      threadId,
      ...pullRequest(number),
      watching: true,
      link: { url: `https://github.com/pingdotgg/t3code/pull/${number}`, source: "agent" },
    });
  });

const send = (threadId: ThreadId, text: string, type: "start_immediately" | "queue_after_active") =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}:${text}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}:${text}`),
      text,
      attachments: [],
      dispatchMode: { type },
      createdBy: "user",
      creationSource: "web",
    });
  });

const delegate = (parentThreadId: ThreadId, task: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.at(-1)!;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make(`delegate:${task}`),
      parentThreadId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      task,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      completionWake: "always",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const projection = yield* orchestrator.getThreadProjection(parentThreadId);
    return projection.subagents.find((candidate) => candidate.prompt === task)!.childThreadId!;
  });

const threadState = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projection = yield* orchestrator.getThreadProjection(threadId);
    return {
      runs: projection.runs.map((run) => `${run.status}${run.queueHeld === true ? ":held" : ""}`),
      watched: (projection.thread.pullRequests ?? [])
        .filter((link) => link.watch !== undefined)
        .map((link) => link.number),
    };
  });

it.effect.each([
  "idle",
  "archived",
  "missing",
  "running",
  "queued",
  "waiting",
  "correlated",
  "provider-active",
  "roster",
  "background",
  "question",
  "restart",
] as const)(
  "Stop clears an orphaned follow-up only when its child is finished (%s)",
  (childState) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const parentThreadId = ThreadId.make(`thread:orphan-parent:${childState}`);
      yield* createWatchingThread(parentThreadId, 1);
      yield* send(parentThreadId, "parent", "start_immediately");
      const childThreadId = yield* delegate(parentThreadId, "original task");
      const parent = yield* orchestrator.getThreadProjection(parentThreadId);
      const child = yield* orchestrator.getThreadProjection(childThreadId);
      const original = parent.subagents[0]!;
      const originalItem = parent.turnItems.find((item) => item.type === "subagent")!;
      const originalNode = parent.nodes.find((node) => node.id === original.id)!;
      const taskId = NodeId.make(`node:orphan-followup:${childState}`);
      const itemId = TurnItemId.make(`item:orphan-followup:${childState}`);
      const followupChildThreadId =
        childState === "missing" ? ThreadId.make("thread:missing-child") : childThreadId;
      const now = yield* DateTime.now;
      let sequence = 0;
      const apply = (event: Omit<OrchestrationV2DomainEvent, "id">) =>
        projections.apply({
          ...event,
          id: EventId.make(`event:orphan:${childState}:${sequence++}`),
        } as OrchestrationV2DomainEvent);
      yield* apply({
        type: "subagent.updated",
        threadId: parentThreadId,
        occurredAt: now,
        payload: {
          ...original,
          status: "completed",
          result: "Original result",
          completedAt: now,
          completionDelivery: { state: "acknowledged", observedByRunId: null },
        },
      });
      yield* apply({
        type: "context-transfer.created",
        threadId: parentThreadId,
        occurredAt: now,
        payload: {
          ...child.contextTransfers[0]!,
          id: ContextTransferId.make(`transfer:original-result:${childState}`),
          type: "subagent_result",
          sourceThreadId: childThreadId,
          targetThreadId: parentThreadId,
          sourcePoint: { threadId: childThreadId, runId: child.runs[0]!.id },
          targetRunId: parent.runs[0]!.id,
        },
      });
      yield* apply({
        type: "node.updated",
        threadId: parentThreadId,
        occurredAt: now,
        payload: { ...originalNode, status: "completed", completedAt: now },
      });
      yield* apply({
        type: "turn-item.updated",
        threadId: parentThreadId,
        occurredAt: now,
        payload: { ...originalItem, status: "completed", completedAt: now },
      });
      yield* apply({
        type: "subagent.updated",
        threadId: parentThreadId,
        occurredAt: now,
        payload: {
          ...original,
          id: taskId,
          childThreadId: followupChildThreadId,
          status: "running",
          result: null,
          completedAt: null,
        },
      });
      yield* apply({
        type: "node.updated",
        threadId: parentThreadId,
        occurredAt: now,
        payload: { ...originalNode, id: taskId, status: "running" },
      });
      assert.equal(originalItem.type, "subagent");
      if (originalItem.type !== "subagent") return;
      yield* apply({
        type: "turn-item.updated",
        threadId: parentThreadId,
        occurredAt: now,
        payload: {
          ...originalItem,
          id: itemId,
          nodeId: taskId,
          subagentId: taskId,
          childThreadId: followupChildThreadId,
          status: "running",
        },
      });
      const runAtStart = child.runs[0]!;
      const childRunStatus =
        childState === "running" || childState === "queued" || childState === "waiting"
          ? childState
          : "completed";
      yield* apply({
        type: "run.updated",
        threadId: childThreadId,
        occurredAt: now,
        payload: { ...runAtStart, status: "running", delegatedTaskId: taskId },
      });
      assert.equal(
        (yield* orchestrator.getThreadProjection(childThreadId)).runs[0]?.delegatedTaskId,
        taskId,
      );
      // A terminal write based on the attempt's start snapshot loses a later steer binding.
      yield* apply({
        type: "run.updated",
        threadId: childThreadId,
        occurredAt: now,
        payload: {
          ...runAtStart,
          status: childRunStatus,
          completedAt: childRunStatus === "completed" ? now : null,
          ...(childState === "correlated" ? { delegatedTaskId: taskId } : {}),
        },
      });
      assert.equal(
        (yield* orchestrator.getThreadProjection(childThreadId)).runs[0]?.delegatedTaskId,
        childState === "correlated" ? taskId : undefined,
      );
      if (childState === "provider-active" || childState === "roster") {
        yield* apply({
          type: "provider-thread.updated",
          threadId: childThreadId,
          occurredAt: now,
          payload: {
            ...child.providerThreads[0]!,
            status: childState === "provider-active" ? "active" : "idle",
            pendingBackgroundTasks:
              childState === "roster" ? [{ taskId: "background-task", kind: "command" }] : [],
          },
        });
      }
      if (childState === "background") {
        yield* apply({
          type: "turn-item.updated",
          threadId: childThreadId,
          occurredAt: now,
          payload: {
            ...originalItem,
            id: TurnItemId.make("item:child-background"),
            threadId: childThreadId,
            runId: runAtStart.id,
            nodeId: runAtStart.rootNodeId,
            type: "command_execution",
            status: "running",
            input: "test background work",
          },
        });
      }
      if (childState === "question") {
        yield* apply({
          type: "runtime-request.updated",
          threadId: childThreadId,
          occurredAt: now,
          payload: {
            id: RuntimeRequestId.make("request:child-question"),
            nodeId: runAtStart.rootNodeId!,
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "user_input",
            status: "pending",
            responseCapability: { type: "message" },
            createdAt: now,
            resolvedAt: null,
          },
        });
      }
      if (childState === "restart") {
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        yield* outbox.enqueue([
          {
            id: `effect:restart-continuation:${runAtStart.id}`,
            commandId: CommandId.make("command:child-restart"),
            threadId: childThreadId,
            request: { type: "provider-runtime.continue", sourceRunId: runAtStart.id },
          },
        ]);
      }
      yield* apply({
        type: "run.updated",
        threadId: parentThreadId,
        occurredAt: now,
        payload: { ...parent.runs[0]!, status: "completed", completedAt: now },
      });
      if (childState === "archived") {
        yield* apply({
          type: "thread.archived",
          threadId: childThreadId,
          occurredAt: now,
          payload: { ...child.thread, archivedAt: now },
        });
      }
      const childBeforeStop = yield* orchestrator.getThreadProjection(childThreadId);
      assert.lengthOf(
        ((yield* orchestrator.getThreadShell(parentThreadId))?.pendingBackgroundTasks ?? []).filter(
          (task) => task.kind === "subagent",
        ),
        1,
      );
      yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make(`stop-orphan:${childState}`),
        threadId: parentThreadId,
      });
      const after = yield* orchestrator.getThreadProjection(parentThreadId);
      assert.isEmpty((after.thread.pullRequests ?? []).filter((link) => link.watch !== undefined));
      const expected = childState === "idle" || childState === "archived" ? "cancelled" : "running";
      assert.equal(after.subagents.find((task) => task.id === taskId)?.status, expected);
      assert.equal(after.nodes.find((node) => node.id === taskId)?.status, expected);
      assert.equal(after.turnItems.find((item) => item.id === itemId)?.status, expected);
      assert.equal(
        after.subagents.find((task) => task.id === taskId)?.completionDelivery?.state,
        "disposed",
      );
      assert.equal(
        after.subagents.find((task) => task.id === original.id)?.result,
        "Original result",
      );
      assert.deepEqual(yield* orchestrator.getThreadProjection(childThreadId), childBeforeStop);
      if (expected === "cancelled") {
        assert.lengthOf(
          (yield* orchestrator.getThreadShell(parentThreadId))?.pendingBackgroundTasks ?? [],
          0,
        );
        yield* orchestrator.recoverDelegatedTasks;
        yield* orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make(`stop-orphan-again:${childState}`),
          threadId: parentThreadId,
        });
        const repeated = yield* orchestrator.getThreadProjection(parentThreadId);
        assert.equal(repeated.subagents.find((task) => task.id === taskId)?.status, "cancelled");
        assert.deepEqual(repeated.messages, after.messages);
        assert.deepEqual(repeated.contextTransfers, after.contextTransfers);
      }
    }).pipe(Effect.provide(layerTest)),
);

it.effect("Stop ends watches, holds queues, and stops the delegated tasks under the thread", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const sql = yield* SqlClient.SqlClient;
    const parentThreadId = ThreadId.make("thread:stop-parent");
    yield* createWatchingThread(parentThreadId, 1);
    yield* send(parentThreadId, "first", "start_immediately");
    const childThreadId = yield* delegate(parentThreadId, "child task");
    assert.isTrue(Exit.isFailure(yield* Effect.exit(watch(childThreadId, 2))));
    const grandchildThreadId = yield* delegate(childThreadId, "grandchild task");
    yield* send(childThreadId, "child follow-up", "queue_after_active");

    const now = yield* DateTime.now;
    const firstRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs[0]!;
    yield* projections.apply({
      id: EventId.make("event:stop-parent:first-run-completed"),
      type: "run.updated",
      threadId: parentThreadId,
      runId: firstRun.id,
      occurredAt: now,
      payload: { ...firstRun, status: "completed", completedAt: now },
    });
    yield* send(parentThreadId, "second", "start_immediately");
    const secondRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.at(-1)!;

    const stopCommandId = CommandId.make("stop-parent");
    yield* orchestrator.dispatch({
      type: "run.interrupt",
      commandId: stopCommandId,
      threadId: parentThreadId,
      runId: secondRun.id,
      holdQueue: true,
    });

    assert.deepEqual(yield* threadState(parentThreadId), {
      runs: ["completed", "interrupted"],
      watched: [],
    });
    const parent = yield* orchestrator.getThreadProjection(parentThreadId);
    assert.equal(parent.subagents[0]?.completionDelivery?.state, "disposed");
    const effects = yield* sql<{ readonly effect_type: string }>`
      SELECT effect_type FROM orchestration_v2_effect_outbox WHERE command_id = ${stopCommandId}
    `;
    assert.include(
      effects.map((row) => row.effect_type),
      "delegated-tasks.stop",
    );

    yield* threads.stopDelegatedTasks({ threadId: parentThreadId, commandId: stopCommandId });
    assert.deepEqual(yield* threadState(childThreadId), {
      runs: ["interrupted", "queued:held"],
      watched: [],
    });
    assert.deepEqual((yield* threadState(grandchildThreadId)).runs, ["interrupted"]);

    yield* threads.stopDelegatedTasks({ threadId: parentThreadId, commandId: stopCommandId });
    assert.deepEqual((yield* threadState(childThreadId)).runs, ["interrupted", "queued:held"]);

    yield* send(parentThreadId, "new work", "start_immediately");
    const newChild = yield* delegate(parentThreadId, "new task after Stop");
    yield* threads.stopDelegatedTasks({ threadId: parentThreadId, commandId: stopCommandId });
    assert.deepEqual((yield* threadState(newChild)).runs, ["starting"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each([1, 2, 8])(
  "Stop visits each descendant once with %s historical tasks per child",
  (tasksPerChild) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
      const rootThreadId = ThreadId.make("thread:stop-history");
      yield* createWatchingThread(rootThreadId, 30);
      yield* send(rootThreadId, "work", "start_immediately");
      const descendants: Array<ThreadId> = [];
      let parentThreadId = rootThreadId;
      for (let depth = 0; depth < 3; depth++) {
        const childThreadId = yield* delegate(parentThreadId, `history child ${depth}`);
        const task = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents[0]!;
        // Published tasks and later follow-ups all retain the same child thread.
        for (let history = 1; history < tasksPerChild; history++) {
          const taskId = NodeId.make(`node:stop-history:${depth}:${history}`);
          yield* projections.apply({
            id: EventId.make(`event:stop-history:${depth}:${history}`),
            type: "subagent.updated",
            threadId: parentThreadId,
            runId: task.runId!,
            nodeId: taskId,
            occurredAt: yield* DateTime.now,
            payload: { ...task, id: taskId, status: "completed" },
          });
        }
        descendants.push(childThreadId);
        parentThreadId = childThreadId;
      }

      const stopped: Array<ThreadId> = [];
      const read: Array<ThreadId> = [];
      const measuredOrchestrator = Orchestrator.OrchestratorV2.of({
        ...orchestrator,
        dispatch: (command) =>
          Effect.sync(() => {
            if (command.type === "thread.stop") stopped.push(command.threadId);
          }).pipe(Effect.andThen(orchestrator.dispatch(command))),
        getThreadRecords: (threadId, fields, filter) =>
          Effect.sync(() => read.push(threadId)).pipe(
            Effect.andThen(orchestrator.getThreadRecords(threadId, fields, filter)),
          ),
      });
      const commandId = CommandId.make("stop-history");
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagementService.ThreadManagementService;
        yield* threads.stopDelegatedTasks({ threadId: rootThreadId, commandId });
      }).pipe(
        Effect.provide(
          Layer.fresh(ThreadManagementService.layer).pipe(
            Layer.provide(Layer.succeed(Orchestrator.OrchestratorV2, measuredOrchestrator)),
          ),
        ),
      );

      // Check real persisted state and receipts before asserting traversal cost.
      for (const threadId of descendants) {
        assert.deepEqual((yield* threadState(threadId)).runs, ["interrupted"]);
        const receipt = yield* receipts.getByCommandId(
          CommandId.make(`${commandId}:stop:${threadId}`),
        );
        assert.isTrue(Option.isSome(receipt));
      }
      assert.deepEqual(stopped, descendants);
      assert.deepEqual(read, [rootThreadId, ...descendants]);
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["thread.stop", "run.interrupt"] as const)(
  "%s cancels buffered wakes and preserves durable queued messages",
  (type) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make(`thread:stop-buffered:${type}`);
      yield* createWatchingThread(threadId, 5);
      yield* send(threadId, "active", "start_immediately");
      yield* send(threadId, "user follow-up", "queue_after_active");
      for (const creationSource of ["provider", "server"] as const) {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`notification:${type}:${creationSource}`),
          threadId,
          messageId: MessageId.make(`notification:${type}:${creationSource}`),
          text: "Background activity updated",
          attachments: [],
          createdBy: "agent",
          creationSource,
          notification: {
            source: { kind: "background_task" },
            outcome: "updated",
            summary: "Background activity updated",
          },
          dispatchMode: { type: "queue_after_active" },
        });
      }
      const before = yield* orchestrator.getThreadProjection(threadId);
      const buffered = before.runs.find((run) =>
        before.messages.some(
          (message) => message.id === run.userMessageId && message.creationSource === "provider",
        ),
      )!;
      const stop = { commandId: CommandId.make(`stop:${type}`), threadId };
      yield* orchestrator.dispatch(
        type === "run.interrupt"
          ? { ...stop, type, runId: before.runs[0]!.id, holdQueue: true }
          : { ...stop, type },
      );
      const stopped = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(stopped.runs.find((run) => run.id === buffered.id)?.status, "cancelled");
      assert.equal(
        stopped.attempts.find((attempt) => attempt.runId === buffered.id)?.status,
        "cancelled",
      );
      assert.equal(
        stopped.nodes.find((node) => node.id === buffered.rootNodeId)?.status,
        "cancelled",
      );
      assert.deepEqual(
        stopped.runs.filter((run) => run.status === "queued").map((run) => run.queueHeld),
        [true, true],
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("a message the user sends after Stop releases the held queue; an agent's does not", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:stop-release");
    const agentSend = (text: string) =>
      orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`agent-send:${text}`),
        threadId,
        messageId: MessageId.make(`message:${threadId}:${text}`),
        text,
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "mcp",
      });
    yield* createWatchingThread(threadId, 6);
    yield* send(threadId, "active", "start_immediately");
    yield* send(threadId, "queued before the stop", "queue_after_active");
    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop-release"),
      threadId,
    });
    assert.deepEqual((yield* threadState(threadId)).runs, ["interrupted", "queued:held"]);

    // An agent's message starts on the idle thread, but the hold is the user's.
    yield* agentSend("agent nudge");
    assert.deepEqual((yield* threadState(threadId)).runs, [
      "interrupted",
      "queued:held",
      "starting",
    ]);
    const nudge = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make("event:stop-release:nudge-completed"),
      type: "run.updated",
      threadId,
      runId: nudge.id,
      occurredAt: now,
      payload: { ...nudge, status: "completed", completedAt: now },
    });

    // A scheduled task the user created is not the user coming back.
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("scheduled-send"),
      threadId,
      messageId: MessageId.make(`message:${threadId}:scheduled`),
      text: "Nightly check",
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: "web",
      scheduledTaskId: ScheduledTaskId.make("scheduled:nightly"),
    });
    const scheduled = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
    assert.deepEqual((yield* threadState(threadId)).runs, [
      "interrupted",
      "queued:held",
      "completed",
      "starting",
    ]);
    yield* projections.apply({
      id: EventId.make("event:stop-release:scheduled-completed"),
      type: "run.updated",
      threadId,
      runId: scheduled.id,
      occurredAt: now,
      payload: { ...scheduled, status: "completed", completedAt: now },
    });

    // The user is back: the held message follows their run, and a wake that
    // queues behind it is not held by the old Stop.
    yield* send(threadId, "back", "start_immediately");
    yield* agentSend("task finished");
    assert.deepEqual((yield* threadState(threadId)).runs, [
      "interrupted",
      "queued",
      "completed",
      "completed",
      "starting",
      "queued",
    ]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "thread.stop ends an idle thread's watches and accepts a thread with nothing to stop",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:stop-idle");
      yield* createWatchingThread(threadId, 3);

      yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("stop-idle"),
        threadId,
      });
      assert.deepEqual(yield* threadState(threadId), { runs: [], watched: [] });

      const again = yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("stop-idle-again"),
        threadId,
      });
      assert.lengthOf(again.storedEvents, 0);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("a run Stop reached cannot delegate or start a watch, even after it ends", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:stop-barrier");
    yield* createWatchingThread(threadId, 4);
    yield* send(threadId, "work", "start_immediately");
    const now = yield* DateTime.now;
    const run = { ...(yield* orchestrator.getThreadProjection(threadId)).runs[0]!, startedAt: now };
    yield* projections.apply({
      id: EventId.make("event:stop-barrier:running"),
      type: "run.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "running" },
    });
    yield* send(threadId, "queued", "queue_after_active");
    const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
    yield* orchestrator.dispatch({
      type: "queued-run.cancel",
      commandId: CommandId.make("cancel-queued"),
      threadId,
      runId: queued.id,
    });
    yield* projections.apply({
      id: EventId.make("event:stop-barrier:interrupt-request"),
      type: "turn-item.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: {
        id: TurnItemId.make("turn-item:stop-barrier:interrupt-request"),
        threadId,
        runId: run.id,
        nodeId: run.rootNodeId!,
        providerThreadId: run.providerThreadId!,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1_000,
        status: "completed",
        title: "Interrupt requested",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "run_interrupt_request",
        message: "Stop",
      },
    });

    assert.isTrue(Exit.isFailure(yield* Effect.exit(delegate(threadId, "late task"))));
    assert.isTrue(Exit.isFailure(yield* Effect.exit(watch(threadId, 5))));

    yield* projections.apply({
      id: EventId.make("event:stop-barrier:interrupted"),
      type: "run.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "interrupted", completedAt: now },
    });
    assert.isTrue(Exit.isFailure(yield* Effect.exit(watch(threadId, 5))));
    assert.deepEqual(yield* threadState(threadId), {
      runs: ["interrupted", "cancelled"],
      watched: [4],
    });

    for (const watching of [false, true]) {
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make(`manual-watch:${watching}`),
        threadId,
        ...pullRequest(4),
        watching,
      });
    }
    assert.deepEqual((yield* threadState(threadId)).watched, [4]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("thread.stop keeps a restart continuation of the stopped run from starting", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("thread:stop-restart");
    yield* createWatchingThread(threadId, 8);
    yield* send(threadId, "work", "start_immediately");
    const now = yield* DateTime.now;
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
    yield* projections.apply({
      id: EventId.make("event:stop-restart:cancelled"),
      type: "run.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "cancelled", startedAt: null, completedAt: now },
    });
    const at = DateTime.formatIso(now);
    yield* sql`
      INSERT INTO orchestration_v2_effect_outbox (
        effect_id, command_id, thread_id, effect_type, payload_json, status,
        attempt_count, available_at, created_at, updated_at
      ) VALUES (
        ${`effect:restart-continuation:${run.id}`}, 'command:restart', ${threadId},
        'provider-runtime.continue',
        ${encodeEffectRequest({ type: "provider-runtime.continue", sourceRunId: run.id })},
        'pending', 0, ${at}, ${at}, ${at}
      )
    `;

    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop-restart"),
      threadId,
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("restart-continuation"),
      threadId,
      messageId: MessageId.make("message:restart-continuation"),
      text: "Continue.",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "agent",
      creationSource: "server",
      restartContinuationOfRunId: run.id,
    });
    assert.deepEqual(yield* threadState(threadId), { runs: ["cancelled"], watched: [] });
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["thread.stop", "run.interrupt"] as const)(
  "a successful %s blocks a newer restart continuation when completion timestamps tie",
  (stopType) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread:stop-resumed-queue");
      yield* createWatchingThread(threadId, 12);
      yield* send(threadId, "first", "start_immediately");
      yield* send(threadId, "queued", "queue_after_active");
      const now = yield* DateTime.now;
      const [first, queued] = (yield* orchestrator.getThreadProjection(threadId)).runs;
      assert.isDefined(first);
      assert.isDefined(queued);
      for (const run of [first!, queued!]) {
        yield* projections.apply({
          id: EventId.make(`event:stop-resumed-queue:hold:${run.id}`),
          type: "run.updated",
          threadId,
          runId: run.id,
          occurredAt: now,
          payload:
            run.id === first!.id
              ? { ...run, status: "completed", completedAt: now }
              : { ...run, queueHeld: true },
        });
      }
      yield* send(threadId, "restart source", "start_immediately");
      const source = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
      yield* projections.apply({
        id: EventId.make("event:stop-resumed-queue:restart-cancelled"),
        type: "run.updated",
        threadId,
        runId: source.id,
        occurredAt: now,
        payload: { ...source, status: "cancelled", startedAt: now, completedAt: now },
      });
      const at = DateTime.formatIso(now);
      yield* sql`
        INSERT INTO orchestration_v2_effect_outbox (
          effect_id, command_id, thread_id, effect_type, payload_json, status,
          attempt_count, available_at, created_at, updated_at
        ) VALUES (
          ${`effect:restart-continuation:${source.id}`}, 'command:restart', ${threadId},
          'provider-runtime.continue',
          ${encodeEffectRequest({ type: "provider-runtime.continue", sourceRunId: source.id })},
          'pending', 0, ${at}, ${at}, ${at}
        )
      `;
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("resume-older-queue"),
        threadId,
      });
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.id === queued!.id,
        )?.status,
        "starting",
      );
      yield* orchestrator.dispatch(
        stopType === "thread.stop"
          ? { type: "thread.stop", commandId: CommandId.make("stop-resumed-queue"), threadId }
          : {
              type: "run.interrupt",
              commandId: CommandId.make("stop-resumed-queue"),
              threadId,
              runId: queued!.id,
              holdQueue: true,
            },
      );
      const stopped = yield* orchestrator.getThreadProjection(threadId);
      const interrupted = stopped.runs.find((run) => run.id === queued!.id)!;
      assert.equal(interrupted.status, "interrupted");
      assert.equal(DateTime.toEpochMillis(interrupted.completedAt!), DateTime.toEpochMillis(now));
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("restart-after-stop"),
        threadId,
        messageId: MessageId.make("message:restart-after-stop"),
        text: "Continue.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "agent",
        creationSource: "server",
        restartContinuationOfRunId: source.id,
      });
      // The held run resumed after the cancelled source ran, so it sorts after it.
      assert.deepEqual(yield* threadState(threadId), {
        runs: ["completed", "cancelled", "interrupted"],
        watched: [],
      });
    }).pipe(Effect.provide(layerTest.pipe(Layer.provideMerge(TestClock.layer())))),
);

it.effect.each([
  { ending: "cancelled", question: "resolved" },
  { ending: "interrupted", question: "resolved" },
  { ending: "completed", question: "pending" },
  { ending: "failed", question: "pending" },
] as const)(
  "a $ending delegated task leaves its async question $question",
  ({ ending, question }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const parentThreadId = ThreadId.make(`thread:stop-question-parent:${ending}`);
      yield* createWatchingThread(parentThreadId, 20);
      yield* send(parentThreadId, "first", "start_immediately");
      const childThreadId = yield* delegate(parentThreadId, `question task ${ending}`);
      const childRun = (yield* orchestrator.getThreadProjection(childThreadId)).runs[0]!;
      assert.equal(
        (yield* orchestrator.getThreadProjection(childThreadId)).nodes.find(
          (node) => node.id === childRun.rootNodeId,
        )?.runId,
        childRun.id,
      );
      const now = yield* DateTime.now;
      yield* projections.apply({
        id: EventId.make("event:stop-question:request"),
        type: "runtime-request.updated",
        threadId: childThreadId,
        runId: childRun.id,
        occurredAt: now,
        payload: {
          id: RuntimeRequestId.make("request:stop-question"),
          nodeId: childRun.rootNodeId!,
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input",
          status: "pending",
          responseCapability: { type: "message" },
          createdAt: now,
          resolvedAt: null,
        },
      });
      const request = Effect.map(
        orchestrator.getThreadProjection(childThreadId),
        (projection) => projection.runtimeRequests[0],
      );

      yield* orchestrator.recoverDelegatedTask(childThreadId, childRun.id);
      assert.equal((yield* request)?.status, "pending");
      if (ending === "interrupted") {
        yield* orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make("stop-question-child"),
          threadId: childThreadId,
        });
      } else {
        yield* projections.apply({
          id: EventId.make(`event:stop-question:${ending}`),
          type: "run.updated",
          threadId: childThreadId,
          runId: childRun.id,
          occurredAt: now,
          payload: { ...childRun, status: ending, startedAt: now, completedAt: now },
        });
      }
      yield* orchestrator.recoverDelegatedTask(childThreadId, childRun.id);
      assert.equal((yield* request)?.status, question);
      assert.equal((yield* request)?.decision, question === "resolved" ? "cancel" : undefined);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("a delegated task that cannot be stopped fails the walk after its siblings stop", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const parentThreadId = ThreadId.make("thread:stop-partial");
    yield* createWatchingThread(parentThreadId, 6);
    yield* send(parentThreadId, "work", "start_immediately");
    const childThreadId = yield* delegate(parentThreadId, "stoppable task");
    const task = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents[0]!;
    yield* projections.apply({
      id: EventId.make("event:stop-partial:missing-task"),
      type: "subagent.updated",
      threadId: parentThreadId,
      runId: task.runId!,
      nodeId: NodeId.make("node:stop-partial:missing"),
      providerInstanceId: instanceId,
      occurredAt: yield* DateTime.now,
      payload: {
        ...task,
        id: NodeId.make("node:stop-partial:missing"),
        childThreadId: ThreadId.make("thread:stop-partial:missing"),
        startedAt: DateTime.subtract(task.startedAt!, { hours: 1 }),
      },
    });

    const walked = yield* Effect.exit(
      threads.stopDelegatedTasks({
        threadId: parentThreadId,
        commandId: CommandId.make("stop-partial"),
      }),
    );
    assert.isTrue(Exit.isFailure(walked));
    assert.deepEqual((yield* threadState(childThreadId)).runs, ["interrupted"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a partial delegated Stop retries only the original children that failed", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const parentThreadId = ThreadId.make("thread:stop-partial");
    yield* createWatchingThread(parentThreadId, 6);
    yield* send(parentThreadId, "work", "start_immediately");
    const rootRefused = yield* threads
      .dispatch({
        type: "thread.stop",
        commandId: CommandId.make("stop-root-above-limit"),
        threadId: parentThreadId,
      })
      .pipe(
        Effect.provideService(DispatchModeLimit, {
          runtimeMode: "approval-required",
          interactionMode: "default",
        }),
        Effect.exit,
      );
    assert.isTrue(Exit.isFailure(rootRefused));
    assert.deepEqual((yield* threadState(parentThreadId)).runs, ["starting"]);
    const blockedChild = yield* delegate(parentThreadId, "default task");
    const advancedChild = yield* delegate(parentThreadId, "default task that advances");
    const stoppedChild = yield* delegate(parentThreadId, "plan task");
    const blockedGrandchild = yield* delegate(stoppedChild, "broader grandchild");
    yield* orchestrator.dispatch({
      type: "thread.runtime-mode.set",
      commandId: CommandId.make("approval-child"),
      threadId: stoppedChild,
      runtimeMode: "approval-required",
    });
    yield* orchestrator.dispatch({
      type: "thread.interaction-mode.set",
      commandId: CommandId.make("plan-child"),
      threadId: stoppedChild,
      interactionMode: "plan",
    });
    const commandId = CommandId.make("stop-partial");
    yield* orchestrator.dispatch({ type: "thread.stop", commandId, threadId: parentThreadId });
    const walked = yield* threads.stopDelegatedTasks({ threadId: parentThreadId, commandId }).pipe(
      Effect.provideService(DispatchModeLimit, {
        runtimeMode: "approval-required",
        interactionMode: "plan",
      }),
      Effect.exit,
    );
    assert.isTrue(Exit.isFailure(walked));
    assert.deepEqual((yield* threadState(stoppedChild)).runs, ["interrupted"]);
    assert.deepEqual((yield* threadState(blockedChild)).runs, ["starting"]);
    assert.deepEqual((yield* threadState(blockedGrandchild)).runs, ["starting"]);

    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("independent-child-stop"),
      threadId: advancedChild,
    });
    yield* send(blockedChild, "queued after failed Stop", "queue_after_active");
    yield* orchestrator.dispatch({
      type: "queued-run.cancel",
      commandId: CommandId.make("cancel-after-failed-stop"),
      threadId: blockedChild,
      runId: (yield* orchestrator.getThreadProjection(blockedChild)).runs.at(-1)!.id,
    });
    yield* send(advancedChild, "new work before failed Stop retry", "start_immediately");
    yield* send(stoppedChild, "new child work", "start_immediately");
    const newGrandchild = yield* delegate(stoppedChild, "new grandchild");
    yield* send(parentThreadId, "new parent work", "start_immediately");
    const newChild = yield* delegate(parentThreadId, "new child");
    yield* threads.stopDelegatedTasks({ threadId: parentThreadId, commandId });
    assert.deepEqual((yield* threadState(blockedChild)).runs, ["interrupted", "cancelled"]);
    assert.deepEqual((yield* threadState(blockedGrandchild)).runs, ["interrupted"]);
    assert.deepEqual((yield* threadState(stoppedChild)).runs, ["interrupted", "starting"]);
    assert.deepEqual((yield* threadState(advancedChild)).runs, ["interrupted", "starting"]);
    assert.deepEqual((yield* threadState(newChild)).runs, ["starting"]);
    assert.deepEqual((yield* threadState(newGrandchild)).runs, ["starting"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a Stop retry with nothing to interrupt is bound by the last run that started", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const completeStartedRun = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const run = (yield* orchestrator.getThreadProjection(threadId)).runs.findLast(
          (candidate) => candidate.status === "starting",
        )!;
        yield* projections.apply({
          id: EventId.make(`event:${run.id}:completed`),
          type: "run.updated",
          threadId,
          runId: run.id,
          occurredAt: now,
          payload: { ...run, status: "completed", startedAt: now, completedAt: now },
        });
      });
    const retryStop = (threadId: ThreadId, throughSequence: number) =>
      orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make(`retry-stop:${threadId}`),
        threadId,
        throughSequence,
      });

    const cancelledQueue = ThreadId.make("thread:stop-retry-cancelled-queue");
    yield* createWatchingThread(cancelledQueue, 13);
    yield* send(cancelledQueue, "work", "start_immediately");
    const cancelledQueueStop = yield* orchestrator.getThreadEventSequence(cancelledQueue);
    yield* send(cancelledQueue, "queued after Stop", "queue_after_active");
    yield* orchestrator.dispatch({
      type: "queued-run.cancel",
      commandId: CommandId.make("cancel-queued-after-stop"),
      threadId: cancelledQueue,
      runId: (yield* orchestrator.getThreadProjection(cancelledQueue)).runs.at(-1)!.id,
    });
    yield* completeStartedRun(cancelledQueue);
    yield* retryStop(cancelledQueue, cancelledQueueStop);
    assert.deepEqual(yield* threadState(cancelledQueue), {
      runs: ["completed", "cancelled"],
      watched: [],
    });

    const newerRun = ThreadId.make("thread:stop-retry-newer-run");
    yield* createWatchingThread(newerRun, 14);
    yield* send(newerRun, "work", "start_immediately");
    const newerRunStop = yield* orchestrator.getThreadEventSequence(newerRun);
    yield* completeStartedRun(newerRun);
    yield* send(newerRun, "work after Stop", "start_immediately");
    yield* completeStartedRun(newerRun);
    yield* retryStop(newerRun, newerRunStop);
    assert.deepEqual(yield* threadState(newerRun), {
      runs: ["completed", "completed"],
      watched: [14],
    });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("thread.stop on a finished thread refuses a late agent watch", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:stop-finished");
    yield* createWatchingThread(threadId, 9);
    yield* send(threadId, "work", "start_immediately");
    const now = yield* DateTime.now;
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
    yield* projections.apply({
      id: EventId.make("event:stop-finished:completed"),
      type: "run.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "completed", startedAt: now, completedAt: now },
    });

    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop-finished"),
      threadId,
    });
    assert.isTrue(Exit.isFailure(yield* Effect.exit(watch(threadId, 10))));
    assert.deepEqual(yield* threadState(threadId), { runs: ["completed"], watched: [] });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("thread.stop marks a turn it cannot interrupt so a late agent watch is refused", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:stop-lost-session");
    yield* createWatchingThread(threadId, 11);
    yield* send(threadId, "work", "start_immediately");
    const now = yield* DateTime.now;
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
    yield* projections.apply({
      id: EventId.make("event:stop-lost-session:running"),
      type: "run.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "running", startedAt: now },
    });
    yield* projections.apply({
      id: EventId.make("event:stop-lost-session:turn"),
      type: "provider-turn.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: ProviderTurnId.make("provider-turn:stop-lost-session"),
        providerThreadId: run.providerThreadId!,
        nodeId: run.rootNodeId!,
        runAttemptId: run.activeAttemptId!,
        nativeTurnRef: null,
        ordinal: 1,
        status: "running",
        startedAt: now,
        completedAt: null,
      },
    });

    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop-lost-session"),
      threadId,
    });
    assert.isTrue(Exit.isFailure(yield* Effect.exit(watch(threadId, 12))));
    assert.deepEqual(yield* threadState(threadId), { runs: ["running"], watched: [] });
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["missing session", "completed", "failed", "cancelled"] as const)(
  "a native child Stop only settles a confirmed %s outcome and preserves its owner and sibling",
  (providerState) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread:native-child-stop");
      yield* createWatchingThread(threadId, 20);
      yield* send(threadId, "owner", "start_immediately");
      yield* delegate(threadId, "native-child-fixture");
      const before = yield* orchestrator.getThreadProjection(threadId);
      const run = before.runs[0]!;
      const now = yield* DateTime.now;
      const subagent = {
        ...before.subagents[0]!,
        origin: "provider_native" as const,
        driver: CLAUDE_PROVIDER,
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        nativeTaskRef: {
          driver: CLAUDE_PROVIDER,
          nativeId: "claude-task",
          strength: "strong" as const,
        },
        status: "running" as const,
        startedAt: now,
      };
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:agent"),
        type: "subagent.updated",
        threadId,
        runId: run.id,
        nodeId: subagent.id,
        occurredAt: now,
        payload: subagent,
      });
      const sibling = {
        ...subagent,
        id: NodeId.make("node:native-stop-sibling"),
        childThreadId: null,
      };
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:sibling"),
        type: "subagent.updated",
        threadId,
        runId: run.id,
        nodeId: sibling.id,
        occurredAt: now,
        payload: sibling,
      });
      const item = before.turnItems.find(
        (item) => item.type === "subagent" && item.subagentId === subagent.id,
      )!;
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:item"),
        type: "turn-item.updated",
        threadId,
        runId: run.id,
        occurredAt: now,
        payload: { ...item, status: "running", completedAt: null },
      });
      const childRoot = {
        ...before.nodes.find((node) => node.id === run.rootNodeId)!,
        id: NodeId.make("node:native-stop-child-root"),
        threadId: subagent.childThreadId!,
        runId: null,
        parentNodeId: null,
        status: "running" as const,
        countsForRun: false,
        completedAt: null,
      };
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:child-root"),
        type: "node.updated",
        threadId: childRoot.threadId,
        nodeId: childRoot.id,
        occurredAt: now,
        payload: childRoot,
      });
      const providerThread = before.providerThreads.find(
        (thread) => thread.id === run.providerThreadId,
      )!;
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:provider-thread"),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: {
          ...providerThread,
          driver: CLAUDE_PROVIDER,
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          providerSessionId: ProviderSessionId.make("session:native-child-stop"),
        },
      });
      const providerTurnId = ProviderTurnId.make("turn:native-child-stop");
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:provider-turn"),
        type: "provider-turn.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: providerTurnId,
          providerThreadId: providerThread.id,
          nodeId: run.rootNodeId!,
          runAttemptId: run.activeAttemptId!,
          nativeTurnRef: null,
          ordinal: 1,
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      });
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:owner-completed"),
        type: "run.updated",
        threadId,
        runId: run.id,
        occurredAt: now,
        payload: { ...run, status: "completed", startedAt: now, completedAt: now },
      });
      yield* send(threadId, "queued", "queue_after_active");
      const stateBefore = yield* threadState(threadId);
      const eventStore = yield* EventStore.EventStoreV2;
      const afterSequence = yield* eventStore.latestSequence({ threadId });
      const confirmedStatus =
        providerState === "completed" || providerState === "failed" || providerState === "cancelled"
          ? providerState
          : null;
      const confirmedOutcome =
        confirmedStatus === null
          ? undefined
          : { status: confirmedStatus, completedAt: now, result: "Actual provider outcome" };
      const commandId = CommandId.make("stop-native-child");
      yield* orchestrator.dispatch({
        type: "subagent.stop",
        commandId,
        threadId,
        runId: run.id,
        subagentId: subagent.id,
      });
      assert.deepEqual(yield* threadState(threadId), stateBefore);
      const effects = yield* sql<{ payload_json: string }>`
      SELECT payload_json FROM orchestration_v2_effect_outbox WHERE command_id = ${commandId}
    `;
      assert.equal(effects.length, 1);
      assert.deepEqual(JSON.parse(effects[0]!.payload_json), {
        type: "provider-turn.interrupt",
        providerSessionId: "session:native-child-stop",
        providerThreadId: providerThread.id,
        providerTurnId,
        subagent: { id: subagent.id, nativeTaskId: "claude-task" },
      });
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadId)).subagents[0]?.status,
        "running",
      );
      const unrelated = yield* Effect.exit(
        orchestrator.dispatch({
          type: "subagent.stop",
          commandId: CommandId.make("stop-unknown-child"),
          threadId,
          runId: run.id,
          subagentId: NodeId.make("unknown-child"),
        }),
      );
      assert.isTrue(Exit.isFailure(unrelated));
      yield* TestClock.adjust("1 second");
      yield* sql`DELETE FROM orchestration_v2_effect_outbox WHERE command_id != ${commandId}`;
      if (providerState === "missing session") {
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* worker.drain();
      } else {
        yield* orchestrator.dispatch({
          type: "thread.background-work.settle",
          commandId: CommandId.make("repair-native-child"),
          threadId,
          providerThreadId: providerThread.id,
          providerTurnId,
          subagent: { id: subagent.id, stoppedAt: now, outcome: confirmedOutcome! },
        });
      }
      const settled = yield* orchestrator.getThreadProjection(threadId);
      const cancelled = settled.subagents.find((task) => task.id === subagent.id)!;
      if (confirmedOutcome === undefined) {
        const events = yield* eventStore.read({ threadId, afterSequence }).pipe(Stream.runCollect);
        assert.isFalse(
          events.some(
            ({ event }) =>
              (event.type === "subagent.updated" ||
                event.type === "node.updated" ||
                event.type === "turn-item.updated") &&
              ["completed", "failed", "cancelled", "interrupted"].includes(event.payload.status),
          ),
        );
        assert.equal(cancelled.status, "running");
        assert.equal(
          (yield* orchestrator.getThreadProjection(childRoot.threadId)).nodes.find(
            (node) => node.id === childRoot.id,
          )?.status,
          "running",
        );
        assert.deepEqual(yield* threadState(threadId), stateBefore);
        return;
      }

      const repaired = yield* eventStore.read({ threadId, afterSequence }).pipe(Stream.runCollect);
      const terminal = repaired.flatMap(({ event }) =>
        (event.type === "subagent.updated" ||
          event.type === "node.updated" ||
          event.type === "turn-item.updated") &&
        event.payload.status === confirmedStatus
          ? [event]
          : [],
      );
      assert.deepEqual(terminal.map((event) => event.type).sort(), [
        "node.updated",
        "subagent.updated",
        "turn-item.updated",
      ]);
      for (const event of terminal) {
        assert.equal(event.nodeId, subagent.id);
        assert.equal(
          DateTime.toEpochMillis(event.payload.completedAt!),
          DateTime.toEpochMillis(confirmedOutcome!.completedAt),
        );
        if (event.type === "subagent.updated" || event.type === "turn-item.updated") {
          assert.isDefined(event.payload.updatedAt);
        }
      }

      assert.equal(cancelled.status, confirmedStatus);
      assert.isNotNull(cancelled.completedAt);
      assert.equal(
        DateTime.toEpochMillis(cancelled.completedAt!),
        DateTime.toEpochMillis(confirmedOutcome!.completedAt),
      );
      assert.equal(cancelled.result, confirmedOutcome!.result);
      assert.equal(
        settled.turnItems.find((candidate) => candidate.id === item.id)?.status,
        confirmedStatus,
      );
      const child = yield* orchestrator.getThreadProjection(childRoot.threadId);
      assert.equal(child.nodes.find((node) => node.id === childRoot.id)?.status, confirmedStatus);
      assert.isNotNull(child.nodes.find((node) => node.id === childRoot.id)?.completedAt);
      assert.equal(settled.subagents.find((task) => task.id === sibling.id)?.status, "running");
      assert.deepEqual(yield* threadState(threadId), stateBefore);
      yield* TestClock.adjust("1 second");
      const resumedAt = yield* DateTime.now;
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:resume"),
        type: "subagent.updated",
        threadId,
        runId: run.id,
        nodeId: subagent.id,
        occurredAt: resumedAt,
        payload: { ...cancelled, status: "running", startedAt: resumedAt, completedAt: null },
      });
      yield* orchestrator.dispatch({
        type: "thread.background-work.settle",
        commandId: CommandId.make("old-stop-after-resume"),
        threadId,
        providerThreadId: providerThread.id,
        providerTurnId,
        subagent: { id: subagent.id, stoppedAt: now, outcome: confirmedOutcome },
      });
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadId)).subagents.find(
          (task) => task.id === subagent.id,
        )?.status,
        "running",
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("an MCP Stop replays its original result after the database and services reopen", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mcp-stop-replay-" });
    const database = fileDatabase(path.join(dir, "statev2.sqlite"));
    const scope: McpInvocationContext.McpInvocationScope = {
      environmentId: EnvironmentId.make("stop-replay"),
      requestNamespace: "client:stop-replay",
      capabilities: new Set(["orchestration"]),
      issuedAt: 1,
      thread: undefined,
      client: { sessionId: "stop-replay", label: "Stop replay", access: "full-access" },
    };
    const threadId = ThreadId.make("thread:mcp-stop-replay");
    const stop = { threadId, stop: true, clientRequestId: "stop" };
    const first = yield* Effect.gen(function* () {
      const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
      const idle = ThreadId.make("thread:mcp-stop-idle");
      yield* createWatchingThread(idle, 102);
      yield* send(idle, "finished work", "start_immediately");
      yield* send(idle, "held queue", "queue_after_active");
      const idleProjection = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(idle);
      const idleRun = idleProjection.runs[0]!;
      const now = yield* DateTime.now;
      yield* (yield* ProjectionStore.ProjectionStoreV2).apply({
        id: EventId.make("event:mcp-stop-idle:completed"),
        type: "run.updated",
        threadId: idle,
        runId: idleRun.id,
        occurredAt: now,
        payload: { ...idleRun, status: "completed", completedAt: now },
      });
      assert.deepEqual(
        yield* mcp.interruptThread(scope, {
          ...stop,
          threadId: idle,
          clientRequestId: "idle-stop",
        }),
        {
          threadId: idle,
          runId: null,
          status: "no_active_run",
        },
      );
      yield* createWatchingThread(threadId, 101);
      const sent = yield* mcp.sendToThread(scope, {
        threadId,
        message: "first",
        clientRequestId: "send",
      });
      const childThreadId = yield* delegate(threadId, "original child");
      yield* delegate(childThreadId, "original grandchild");
      const stopped = yield* mcp.interruptThread(scope, stop);
      assert.equal(stopped.runId, sent.runId);
      return { sent, stopped };
    }).pipe(Effect.provide(layerMcp(database).pipe(Layer.fresh)));

    yield* Effect.gen(function* () {
      const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const replay = yield* mcp.sendToThread(scope, {
        threadId,
        message: "first",
        clientRequestId: "send",
      });
      assert.equal(replay.runId, first.sent.runId);
      assert.equal((yield* orchestrator.getThreadProjection(threadId)).runs.length, 1);
      yield* send(threadId, "after restart", "start_immediately");
      const newChild = yield* delegate(threadId, "child after restart");
      assert.deepEqual(yield* mcp.interruptThread(scope, stop), first.stopped);
      assert.deepEqual((yield* threadState(threadId)).runs, ["interrupted", "starting"]);
      assert.deepEqual((yield* threadState(newChild)).runs, ["starting"]);
    }).pipe(Effect.provide(layerMcp(database).pipe(Layer.fresh)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
