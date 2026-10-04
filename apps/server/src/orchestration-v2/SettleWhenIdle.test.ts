import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  CommandId,
  EnvironmentId,
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
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/unstable/ai";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for settlement decisions"),
} as ProviderAdapterV2Shape;
const database = SqlitePersistenceMemory;
const testLayer = Layer.mergeAll(
  database,
  EventStore.layer.pipe(Layer.provide(database)),
  ProjectionStore.layer.pipe(Layer.provide(database)),
  makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "settle-when-idle" },
    ProviderAdapterRegistry.makeLayer([adapter]),
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
  const fulfill = (requestedAt: DateTime.Utc) =>
    orchestrator.dispatch({
      type: "thread.settle-when-idle",
      commandId: commandId(),
      threadId,
      requestedAt,
    });
  const read = () => projections.getThread(threadId);
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
      const request = armed.settleWhenIdleAt!;
      yield* f.setRun("waiting");
      assert.equal((yield* Effect.exit(f.fulfill(request)))._tag, "Failure");
      yield* f.setRun("completed");
      const finished = yield* f.fulfill(request);
      assert.include(
        finished.storedEvents.map(({ event }) => event.type),
        "provider-session.detached",
      );
      assert.isEmpty((yield* f.projections.getThreadProviderContext(f.threadId)).providerSessions);
      assert.equal((yield* f.read()).settledOverride, "settled");
      assert.isNull((yield* f.read()).settleWhenIdleAt);
      assert.equal((yield* Effect.exit(f.fulfill(request)))._tag, "Failure");
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
      yield* f.fulfill(request);
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
      const request = (yield* f.read()).settleWhenIdleAt!;
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
      assert.equal((yield* Effect.exit(f.fulfill(request)))._tag, "Failure");
      assert.notEqual((yield* f.read()).settledOverride, "settled");
    }).pipe(Effect.provide(testLayer)),
);

it.effect.each(["failed", "interrupted", "cancelled", "rolled_back"] as const)(
  "%s cancels the durable intent in the same event transaction",
  (status) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.settle();
      const events = yield* f.setRun(status);
      assert.equal(events.at(-1)?.event.type, "thread.settle-when-idle-set");
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

it.effect("background commands continue after the root run and block actual settlement", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.settle();
    const request = (yield* f.read()).settleWhenIdleAt!;
    yield* f.setRun("completed");
    const item = {
      id: TurnItemId.make("background-command"),
      type: "command_execution" as const,
      threadId: f.threadId,
      runId: f.run.id,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "running" as const,
      title: "Background command",
      startedAt: f.now,
      completedAt: null,
      updatedAt: f.now,
      input: "sleep 40",
      output: "",
    };
    yield* f.sink.write({
      events: [
        {
          id: EventId.make("background-start"),
          type: "turn-item.updated",
          threadId: f.threadId,
          occurredAt: f.now,
          payload: item,
        },
      ],
    });
    assert.equal((yield* Effect.exit(f.fulfill(request)))._tag, "Failure");
    assert.deepEqual((yield* f.read()).settleWhenIdleAt, request);
    yield* f.sink.write({
      events: [
        {
          id: EventId.make("background-end"),
          type: "turn-item.updated",
          threadId: f.threadId,
          occurredAt: f.now,
          payload: { ...item, status: "completed", completedAt: f.now },
        },
      ],
    });
    yield* f.fulfill(request);
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
        assert.equal((yield* Effect.exit(f.fulfill(request!)))._tag, "Failure");
        assert.deepEqual((yield* f.read()).settleWhenIdleAt, request);
      }
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "MCP can settle its own running thread, finish the run, and fulfill the same intent",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const registration = McpHttpServer.ThreadToolkitRegistrationLive.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(
          ThreadManagement.layer.pipe(
            Layer.provide(Layer.succeed(Orchestrator.OrchestratorV2, f.orchestrator)),
          ),
        ),
        Layer.provide(NodeCrypto.layer),
      );
      yield* Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const result = yield* server
          .callTool({ name: "t3_thread_organize", arguments: { action: "settle" } })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, {
              environmentId: EnvironmentId.make("environment:settlement"),
              threadId: f.threadId,
              providerSessionId: "session:settlement",
              providerInstanceId: instanceId,
              issuedAt: 0,
              capabilities: new Set(["orchestration"] as const),
            }),
            Effect.provideService(
              McpSchema.McpServerClient,
              McpSchema.McpServerClient.of({
                clientId: 1,
                protocolVersion: "2025-06-18",
                clientCapabilities: {},
                clientInfo: { name: "settlement-test", version: "1" },
                initializePayload: {
                  protocolVersion: "2025-06-18",
                  capabilities: {},
                  clientInfo: { name: "settlement-test", version: "1" },
                },
                getClient: Effect.die("unused"),
              }),
            ),
          );
        assert.notEqual(result.isError, true);
        assert.property(result.structuredContent, "sequence");
        const request = (yield* f.read()).settleWhenIdleAt;
        assert.isNotNull(request);
        assert.isDefined(request);
        assert.equal((yield* f.projections.getThreadShell(f.threadId))?.status, "running");
        yield* f.setRun("completed");
        yield* f.fulfill(request!);
        assert.equal((yield* f.read()).settledOverride, "settled");
      }).pipe(Effect.provide(registration));
    }).pipe(Effect.provide(testLayer)),
);
