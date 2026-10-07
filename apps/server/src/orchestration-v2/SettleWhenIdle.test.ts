import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderSessionId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for settlement decisions"),
} as ProviderAdapterV2Shape;
const database = SqlitePersistence.layerMemory;
const testLayer = Layer.mergeAll(
  database,
  EventStore.layer.pipe(Layer.provide(database)),
  ProjectionStore.layer.pipe(Layer.provide(database)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "settle-when-idle" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);

const fixture = Effect.fn("settlementFixture")(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make("thread:settle-when-idle");
  let sequence = 0;
  const commandId = () => CommandId.make(`settlement:${++sequence}`);
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: commandId(),
    threadId,
    projectId: ProjectId.make("project:settlement"),
    title: "Finish and put away",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  const run: OrchestrationV2Run = {
    id: RunId.make("run:settlement"),
    threadId,
    ordinal: 1,
    providerInstanceId: instanceId,
    modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make("message:settlement"),
    rootNodeId: null,
    activeAttemptId: null,
    status: "running",
    requestedAt: now,
    startedAt: now,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  const setRun = (status: OrchestrationV2Run["status"]) =>
    sink.write({
      events: [
        {
          id: EventId.make(`event:run:${++sequence}`),
          type: "run.updated",
          threadId,
          occurredAt: now,
          payload: {
            ...run,
            status,
            completedAt: ["completed", "failed", "cancelled", "interrupted"].includes(status)
              ? now
              : null,
          },
        },
      ],
    });
  yield* setRun("running");
  const settle = () =>
    orchestrator.dispatch({ type: "thread.settle", commandId: commandId(), threadId });
  const fulfill = () =>
    orchestrator.dispatch({ type: "thread.settle-when-idle", commandId: commandId(), threadId });
  const read = () => projections.getThread(threadId);
  // A dev server is a command; anything else the agent left running wakes it.
  const setBackground = (
    type: "command_execution" | "dynamic_tool",
    status: "running" | "completed",
  ) =>
    sink.write({
      events: [
        {
          id: EventId.make(`event:background:${++sequence}`),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`background:${type}`),
            threadId,
            runId: run.id,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status,
            title: null,
            startedAt: now,
            completedAt: status === "completed" ? now : null,
            updatedAt: now,
            ...(type === "command_execution"
              ? { type, input: "pnpm dev", output: "" }
              : { type, toolName: "Monitor", input: { command: "watch ci" } }),
          },
        },
      ],
    });
  return {
    orchestrator,
    projections,
    sink,
    now,
    threadId,
    commandId,
    setRun,
    settle,
    fulfill,
    read,
    setBackground,
    run,
  };
});

it.effect(
  "files a running thread without settlement or provider cleanup and waits through finalization",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const sessionId = ProviderSessionId.make("running-session");
      yield* f.sink.write({
        events: [
          {
            id: EventId.make("attached-session"),
            type: "provider-session.attached",
            threadId: f.threadId,
            occurredAt: f.now,
            payload: {
              id: sessionId,
              driver: adapter.driver,
              providerInstanceId: instanceId,
              status: "ready",
              cwd: "/repo",
              model: modelSelection.model,
              capabilities: CodexProviderCapabilitiesV2,
              createdAt: f.now,
              updatedAt: f.now,
              lastError: null,
            },
          },
        ],
      });
      const accepted = yield* f.settle();
      assert.equal(
        (yield* f.projections.getThreadProviderContext(f.threadId)).providerSessions[0]?.id,
        sessionId,
      );
      assert.deepEqual(
        accepted.storedEvents.map(({ event }) => event.type),
        ["thread.settle-when-idle-set"],
      );
      const armed = yield* f.read();
      assert.isNotNull(armed.settleWhenIdleAt);
      assert.isNull(armed.settledOverride);
      assert.equal(
        (yield* f.projections.getThreadShell(f.threadId))?.settleWhenIdleAt?.toString(),
        armed.settleWhenIdleAt?.toString(),
      );
      yield* TestClock.adjust("1 minute");
      yield* f.setRun("waiting");
      assert.equal((yield* Effect.exit(f.fulfill()))._tag, "Failure");
      yield* f.setRun("completed");
      const finished = yield* f.fulfill();
      assert.include(
        finished.storedEvents.map(({ event }) => event.type),
        "provider-session.detached",
      );
      assert.isEmpty((yield* f.projections.getThreadProviderContext(f.threadId)).providerSessions);
      const settled = yield* f.read();
      assert.equal(settled.settledOverride, "settled");
      assert.isNull(settled.settleWhenIdleAt);
      // It keeps its place on the shelf instead of jumping to the top.
      assert.deepEqual(settled.settledAt, armed.settleWhenIdleAt);
      assert.equal((yield* Effect.exit(f.fulfill()))._tag, "Failure");
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "explicit intent survives keep-active and disabled automatic settlement, and is recoverable from SQL",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.orchestrator.dispatch({
        type: "thread.unsettle",
        commandId: f.commandId(),
        threadId: f.threadId,
        reason: "user",
      });
      yield* f.orchestrator.dispatch({
        type: "thread.auto-settle.set",
        commandId: f.commandId(),
        threadId: f.threadId,
        enabled: false,
      });
      yield* f.settle();
      const request = (yield* f.read()).settleWhenIdleAt!;
      yield* f.setRun("completed");
      const recovered = yield* f.projections.getSettlementCandidates(undefined, true);
      assert.equal(recovered.length, 1);
      assert.equal(recovered[0]?.settledOverride, "active");
      assert.deepEqual(recovered[0]?.settleWhenIdleAt, request);
      yield* f.fulfill();
      assert.equal((yield* f.read()).settledOverride, "settled");
    }).pipe(Effect.provide(testLayer)),
);

it.effect.each([
  "thread.unsettle",
  "thread.pin",
  "thread.snooze",
  "thread.active.reorder",
] as const)(
  "%s cancels the intent without interrupting work; old fulfillment cannot settle it",
  (action) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.settle();
      const common = { commandId: f.commandId(), threadId: f.threadId };
      yield* f.orchestrator.dispatch(
        action === "thread.unsettle"
          ? { ...common, type: action, reason: "user" }
          : action === "thread.snooze"
            ? { ...common, type: action, snoozedUntil: "2099-01-01T00:00:00.000Z" }
            : action === "thread.active.reorder"
              ? { ...common, type: action, orderKey: "a0" }
              : { ...common, type: action },
      );
      assert.isNull((yield* f.read()).settleWhenIdleAt);
      assert.equal((yield* f.projections.getThreadShell(f.threadId))?.status, "running");
      yield* f.setRun("completed");
      assert.equal((yield* Effect.exit(f.fulfill()))._tag, "Failure");
      assert.notEqual((yield* f.read()).settledOverride, "settled");
    }).pipe(Effect.provide(testLayer)),
);

it.effect.each(["failed", "interrupted", "cancelled"] as const)(
  "a %s run brings the thread back, and replay keeps it back",
  (status) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.settle();
      yield* f.setRun(status);
      assert.isNull((yield* f.read()).settleWhenIdleAt);
      assert.notEqual((yield* f.read()).settledOverride, "settled");
      // Reapply the stored log into a cleared projection, as startup rebuild does.
      const sql = yield* SqlClient.SqlClient;
      const store = yield* EventStore.EventStoreV2;
      const stored = yield* Stream.runCollect(store.read({ threadId: f.threadId }));
      yield* sql`DELETE FROM orchestration_v2_projection_threads WHERE thread_id = ${f.threadId}`;
      for (const entry of stored) yield* f.projections.apply(entry.event);
      assert.isNull((yield* f.read()).settleWhenIdleAt);
      assert.notEqual((yield* f.read()).settledOverride, "settled");
    }).pipe(Effect.provide(testLayer)),
);

it.effect("dropping a queued delivery that never started keeps the thread filed", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.settle();
    const filedAt = (yield* f.read()).settleWhenIdleAt;
    yield* f.sink.write({
      events: [
        {
          id: EventId.make("dropped-delivery"),
          type: "run.updated",
          threadId: f.threadId,
          occurredAt: f.now,
          payload: {
            ...f.run,
            id: RunId.make("run:delivery"),
            ordinal: 2,
            status: "cancelled",
            startedAt: null,
            completedAt: f.now,
          },
        },
      ],
    });
    assert.deepEqual((yield* f.read()).settleWhenIdleAt, filedAt);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("a new question cancels filing and a blocked thread cannot be filed again", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.settle();
    yield* f.sink.write({
      events: [
        {
          id: EventId.make("question"),
          type: "runtime-request.updated",
          threadId: f.threadId,
          occurredAt: f.now,
          payload: {
            id: RuntimeRequestId.make("question"),
            nodeId: NodeId.make("question"),
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "user_input",
            status: "pending",
            responseCapability: { type: "message" },
            createdAt: f.now,
            resolvedAt: null,
          },
        },
      ],
    });
    assert.isNull((yield* f.read()).settleWhenIdleAt);
    assert.equal((yield* Effect.exit(f.settle()))._tag, "Failure");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("a dev server left running does not keep an idle thread from settling", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.setRun("completed");
    yield* f.setBackground("command_execution", "running");
    yield* f.settle();
    const thread = yield* f.read();
    assert.equal(thread.settledOverride, "settled");
    assert.isNull(thread.settleWhenIdleAt);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("background work that wakes the agent keeps a filed thread until it ends", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.settle();
    yield* f.setRun("completed");
    yield* f.setBackground("dynamic_tool", "running");
    assert.equal((yield* Effect.exit(f.fulfill()))._tag, "Failure");
    assert.isNotNull((yield* f.read()).settleWhenIdleAt);
    yield* f.setBackground("dynamic_tool", "completed");
    yield* f.fulfill();
    assert.equal((yield* f.read()).settledOverride, "settled");
  }).pipe(Effect.provide(testLayer)),
);

it.effect.each(["user", "agent"] as const)(
  "%s follow-up updates the intent according to its author",
  (createdBy) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const providerThreadId = ProviderThreadId.make("queued-provider-thread");
      yield* f.sink.write({
        events: [
          {
            id: EventId.make("queue-provider"),
            type: "provider-thread.updated",
            threadId: f.threadId,
            occurredAt: f.now,
            payload: {
              id: providerThreadId,
              driver: adapter.driver,
              providerInstanceId: instanceId,
              providerSessionId: null,
              appThreadId: f.threadId,
              ownerNodeId: null,
              nativeThreadRef: null,
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: 1,
              lastRunOrdinal: 1,
              handoffIds: [],
              forkedFrom: null,
              createdAt: f.now,
              updatedAt: f.now,
            },
          },
          {
            id: EventId.make("queue-run-binding"),
            type: "run.updated",
            threadId: f.threadId,
            occurredAt: f.now,
            payload: { ...f.run, providerThreadId },
          },
        ],
      });
      yield* f.settle();
      const request = (yield* f.read()).settleWhenIdleAt;
      yield* f.orchestrator.dispatch({
        type: "message.dispatch",
        commandId: f.commandId(),
        threadId: f.threadId,
        messageId: MessageId.make("follow-up"),
        text: "Continue",
        attachments: [],
        createdBy,
        creationSource: createdBy === "user" ? "web" : "mcp",
        modelSelection,
        dispatchMode: { type: "queue_after_active" },
      });
      assert.deepEqual((yield* f.read()).settleWhenIdleAt, createdBy === "user" ? null : request);
      if (createdBy === "agent") {
        yield* f.setRun("completed");
        assert.equal((yield* Effect.exit(f.fulfill()))._tag, "Failure");
        assert.deepEqual((yield* f.read()).settleWhenIdleAt, request);
      }
    }).pipe(Effect.provide(testLayer)),
);

it.effect("a pull request watch does not keep a filed thread, and settling ends it", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.orchestrator.dispatch({
      type: "thread.pull-request.watch",
      commandId: f.commandId(),
      threadId: f.threadId,
      host: "github.com",
      repository: "pingdotgg/t3code",
      number: 7,
      watching: true,
      link: { url: "https://github.com/pingdotgg/t3code/pull/7", source: "agent" },
    });
    yield* f.settle();
    assert.isNotNull((yield* f.read()).settleWhenIdleAt);
    yield* f.setRun("completed");
    // The watch is listed as work that wakes the agent, yet Settle stops it.
    assert.deepEqual(
      (yield* f.projections.getThreadShell(f.threadId))?.pendingBackgroundTasks?.map(
        (task) => task.kind,
      ),
      ["monitor"],
    );
    yield* f.fulfill();
    const shell = yield* f.projections.getThreadShell(f.threadId);
    assert.equal(shell?.settledOverride, "settled");
    assert.isUndefined(shell?.pullRequests?.[0]?.watch);
  }).pipe(Effect.provide(testLayer)),
);

const bindProviderThread = (f: Effect.Success<ReturnType<typeof fixture>>) =>
  Effect.gen(function* () {
    const providerThreadId = ProviderThreadId.make("held-provider-thread");
    yield* f.sink.write({
      events: [
        {
          id: EventId.make("held-provider"),
          type: "provider-thread.updated",
          threadId: f.threadId,
          occurredAt: f.now,
          payload: {
            id: providerThreadId,
            driver: adapter.driver,
            providerInstanceId: instanceId,
            providerSessionId: null,
            appThreadId: f.threadId,
            ownerNodeId: null,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: f.now,
            updatedAt: f.now,
          },
        },
        {
          id: EventId.make("held-run-binding"),
          type: "run.updated",
          threadId: f.threadId,
          occurredAt: f.now,
          payload: { ...f.run, providerThreadId },
        },
      ],
    });
  });

// Restart recovery holds the queue until the user resumes it.
const holdQueue = (f: Effect.Success<ReturnType<typeof fixture>>) =>
  Effect.gen(function* () {
    const { runs } = yield* f.orchestrator.getThreadProjection(f.threadId);
    const queued = runs.filter((run) => run.status === "queued");
    assert.isNotEmpty(queued);
    yield* f.sink.write({
      events: queued.map((run) => ({
        id: EventId.make(`hold:${run.id}`),
        type: "run.updated" as const,
        threadId: f.threadId,
        occurredAt: f.now,
        payload: { ...run, queueHeld: true },
      })),
    });
    return queued;
  });

it.effect("a held automatic run does not keep a filed thread, and settling cancels it", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* bindProviderThread(f);
    yield* f.settle();
    yield* f.orchestrator.dispatch({
      type: "message.dispatch",
      commandId: f.commandId(),
      threadId: f.threadId,
      messageId: MessageId.make("held-notification"),
      text: "Background activity updated",
      attachments: [],
      createdBy: "agent",
      creationSource: "provider",
      notification: {
        source: { kind: "background_task" },
        outcome: "updated",
        summary: "Background activity updated",
      },
      modelSelection,
      dispatchMode: { type: "queue_after_active" },
    });
    const [held] = yield* holdQueue(f);
    yield* f.setRun("completed");
    yield* f.fulfill();
    assert.equal((yield* f.read()).settledOverride, "settled");
    const { runs } = yield* f.orchestrator.getThreadProjection(f.threadId);
    assert.equal(runs.find((run) => run.id === held?.id)?.status, "cancelled");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("a held user message blocks Settle on a working thread instead of filing it", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* bindProviderThread(f);
    yield* f.orchestrator.dispatch({
      type: "message.dispatch",
      commandId: f.commandId(),
      threadId: f.threadId,
      messageId: MessageId.make("held-user-message"),
      text: "Then do this",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
      modelSelection,
      dispatchMode: { type: "queue_after_active" },
    });
    yield* holdQueue(f);
    assert.equal((yield* Effect.exit(f.settle()))._tag, "Failure");
    const thread = yield* f.read();
    assert.notExists(thread.settleWhenIdleAt);
    assert.notEqual(thread.settledOverride, "settled");
  }).pipe(Effect.provide(testLayer)),
);
