// Frame-driven unit tests for the ZCode adapter: a fake NDJSON peer is injected through
// ZcodeAdapterV2Options.makeConnection, and the real makeZcodeAdapterV2 drives it end to end.
// Frames are hand-written from the Phase 0 probe notes; live-recorded replay fixtures (Phase 3)
// must replace or augment these before merge confidence is complete.
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { ZcodeAdapterV2Driver } from "@t3tools/provider-zcode/server";
import { ZCODE_PROVIDER, makeZcodeAdapterV2 } from "@t3tools/provider-zcode/testing";

import {
  type FakeZcodeScenario,
  ZcodeAdapterTestLayer,
  makeFakeZcodeConnection,
  makeZcodeAdapterOptions,
  zcodeDriverKind,
  zcodeServerRequest,
  zcodeSessionEvent,
} from "./ZcodeAdapterV2.testkit.ts";

const INSTANCE_ID = ProviderInstanceId.make("zcode_frame_test");
const THREAD_ID = ThreadId.make("thread-zcode-frame-test");
const PROVIDER_SESSION_ID = ProviderSessionId.make("provider-session-zcode-frame-test");
const MODEL_SELECTION = { instanceId: INSTANCE_ID, model: "default" };
const TURN_TEXT = "Run the zcode frame tests";

const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "approval-required",
  interactionMode: "default",
  cwd: null,
});

const makeTurnInput = Effect.fnUntraced(function* (
  providerThread: OrchestrationV2ProviderThread,
  text = TURN_TEXT,
): Effect.fn.Return<ProviderAdapter.ProviderAdapterV2TurnInput> {
  const now = yield* DateTime.now;
  const threadId = providerThread.appThreadId ?? THREAD_ID;
  const appThread: OrchestrationV2AppThread = {
    id: threadId,
    projectId: ProjectId.make("project-zcode-frame-test"),
    title: "ZCode frame test",
    createdBy: "user",
    creationSource: "web",
    providerInstanceId: providerThread.providerInstanceId,
    modelSelection: MODEL_SELECTION,
    runtimeMode: runtimePolicy.runtimeMode,
    interactionMode: runtimePolicy.interactionMode,
    branch: null,
    worktreePath: null,
    activeProviderThreadId: providerThread.id,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  return {
    appThread,
    threadId,
    runId: RunId.make("run-zcode-frame-1"),
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId: RunAttemptId.make("attempt-zcode-frame-1"),
    rootNodeId: NodeId.make("root-zcode-frame-1"),
    providerThread,
    message: {
      messageId: MessageId.make("message-zcode-frame-1"),
      text,
      attachments: [],
      createdBy: "user",
      creationSource: "web",
      scheduledTaskId: undefined,
      senderThreadId: undefined,
    },
    modelSelection: MODEL_SELECTION,
    runtimePolicy,
  };
});

const makeHarness = Effect.fnUntraced(function* () {
  const scenario = yield* makeFakeZcodeConnection();
  const adapter = yield* makeZcodeAdapterV2({
    ...makeZcodeAdapterOptions(),
    makeConnection: () => Effect.succeed(scenario.connection),
  });
  const runtime = yield* adapter.openSession({
    threadId: THREAD_ID,
    providerSessionId: PROVIDER_SESSION_ID,
    modelSelection: MODEL_SELECTION,
    runtimePolicy,
  });
  const emitted = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  const allEvents: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
  yield* runtime.events.pipe(
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        allEvents.push(event);
        yield* Queue.offer(emitted, event);
      }),
    ),
    Effect.ignore,
    Effect.forkScoped,
  );
  const providerThread = yield* runtime.ensureThread({
    threadId: THREAD_ID,
    modelSelection: MODEL_SELECTION,
    runtimePolicy,
  });
  const takeEvent = Effect.fnUntraced(function* <
    T extends ProviderAdapter.ProviderAdapterV2Event["type"],
  >(
    type: T,
    predicate: (
      event: Extract<ProviderAdapter.ProviderAdapterV2Event, { type: T }>,
    ) => boolean = () => true,
  ) {
    while (true) {
      const event = yield* Queue.take(emitted);
      if (
        event.type === type &&
        predicate(event as Extract<ProviderAdapter.ProviderAdapterV2Event, { type: T }>)
      ) {
        return event as Extract<ProviderAdapter.ProviderAdapterV2Event, { type: T }>;
      }
    }
  });
  const offerTurnEvent = (type: string, payload: Record<string, unknown>) =>
    scenario.offerEvent(
      zcodeSessionEvent(scenario.createdSessionId() ?? "sess_missing", type, payload),
    );
  return {
    scenario,
    runtime,
    providerThread,
    allEvents,
    takeEvent,
    offerTurnEvent,
    startTurn: (text?: string) =>
      Effect.gen(function* () {
        const input = yield* makeTurnInput(providerThread, text);
        return yield* runtime.startTurn(input);
      }),
  };
});

const requestFor = (scenario: FakeZcodeScenario, method: string) =>
  scenario.requests.find((call) => call.method === method);

describe("ZcodeAdapterV2 (frame-driven)", () => {
  it("exposes the driver kind and default config through the package driver", () => {
    assert.equal(ZcodeAdapterV2Driver.driverKind, ZCODE_PROVIDER);
    assert.equal(zcodeDriverKind, ZCODE_PROVIDER);
    assert.equal(ZcodeAdapterV2Driver.defaultConfig().binaryPath, "zcode");
  });

  it.effect(
    "creates the native session, answers server requests, and injects the T3 MCP server",
    () =>
      Effect.gen(function* () {
        yield* (yield* McpProviderSessions.McpProviderSessions).set({
          environmentId: EnvironmentId.make("environment-zcode-frame-test"),
          threadId: THREAD_ID,
          providerSessionId: "zcode-frame-session",
          providerInstanceId: INSTANCE_ID,
          endpoint: "http://127.0.0.1:43999/mcp",
          authorizationHeader: "Bearer zcode-frame-test-token",
          browserToolsAvailable: true,
        });
        const harness = yield* makeHarness();
        assert.equal(harness.providerThread.nativeThreadRef?.nativeId, "sess_1");

        const create = requestFor(harness.scenario, "session/create");
        assert.isDefined(create);
        const workspace = (create!.params["workspace"] ?? {}) as Record<string, unknown>;
        assert.equal(workspace["workspaceKey"], workspace["workspacePath"]);
        assert.equal((workspace["workspacePath"] as string).length > 0, true);
        assert.equal(create!.params["titleGenerationEnabled"], false);
        // "default" defers to the CLI's own model selection.
        assert.equal(create!.params["model"], undefined);
        assert.deepEqual(create!.params["mcpServers"], [
          {
            name: "t3-code",
            type: "http",
            url: "http://127.0.0.1:43999/mcp",
            headers: [{ name: "Authorization", value: "Bearer zcode-frame-test-token" }],
          },
        ]);

        // The broker requests the fake pushed during session/create must be answered; the
        // respond queue synchronizes the assertions with the adapter's pump.
        const preferenceRespond = yield* harness.scenario.takeRespond;
        assert.deepEqual(preferenceRespond.result, {
          nativeSearchEnhancementsEnabled: false,
          toolSearchMode: "off",
          memoryEnabled: false,
          askUserQuestionAutoResolutionEnabled: true,
          modelContextBudgetStrategy: "preflight-v1",
        });
        const mcpAuthRespond = yield* harness.scenario.takeRespond;
        assert.deepEqual(mcpAuthRespond.result, {});

        yield* harness.takeEvent("provider_thread.updated");
        assert.deepEqual(harness.scenario.unexpectedMethods(), []);
      }).pipe(Effect.scoped, Effect.provide(ZcodeAdapterTestLayer)),
  );

  it.effect("streams text deltas and completes the turn with token usage", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.startTurn();
      const send = requestFor(harness.scenario, "session/send");
      assert.isDefined(send);
      assert.equal(send!.params["sessionId"], "sess_1");
      assert.equal(send!.params["content"], TURN_TEXT);
      assert.equal(send!.params["modelSelection"], undefined);

      yield* harness.takeEvent(
        "provider_turn.updated",
        (event) => event.providerTurn.status === "running",
      );
      yield* harness.offerTurnEvent("turn.started", {});
      yield* harness.offerTurnEvent("part.delta", {
        messageId: "msg_a",
        partId: "p1",
        field: "text",
        delta: "Hello",
      });
      yield* harness.offerTurnEvent("part.delta", {
        messageId: "msg_a",
        partId: "p1",
        field: "text",
        delta: " world",
      });
      yield* harness.offerTurnEvent("part.upserted", {
        part: {
          partId: "p1",
          sessionId: "sess_1",
          messageId: "msg_a",
          type: "text",
          text: "Hello world",
        },
      });
      yield* harness.offerTurnEvent("turn.completed", {
        response: "Hello world",
        tokenCount: 120,
        toolCallCount: 0,
        duration: 420,
        resultType: "success",
      });

      const firstDelta = yield* harness.takeEvent("command_output.delta");
      assert.equal(firstDelta.chunk, "Hello");
      const secondDelta = yield* harness.takeEvent("command_output.delta");
      assert.equal(secondDelta.chunk, " world");

      yield* harness.takeEvent("turn_item.updated", (event) =>
        event.turnItem.type === "assistant_message"
          ? event.turnItem.streaming === false && event.turnItem.text === "Hello world"
          : false,
      );
      yield* harness.takeEvent("message.updated", (event) => event.message.text === "Hello world");
      // The completed turn update precedes the terminal on the adapter stream.
      const finalTurnUpdate = yield* harness.takeEvent(
        "provider_turn.updated",
        (event) => event.providerTurn.status === "completed",
      );
      assert.equal(finalTurnUpdate.providerTurn.tokenUsage?.usedTokens, 120);
      yield* harness.takeEvent("turn.terminal", (event) => event.status === "completed");
      assert.deepEqual(harness.scenario.unexpectedMethods(), []);
    }).pipe(Effect.scoped, Effect.provide(ZcodeAdapterTestLayer)),
  );

  it.effect("maps shell tool lifecycle into command execution items", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.startTurn();
      yield* harness.offerTurnEvent("tool.updated", {
        kind: "started",
        toolCallId: "call_1",
        toolName: "Bash",
        input: { command: "echo hi" },
      });
      yield* harness.offerTurnEvent("tool.updated", {
        kind: "result",
        toolCallId: "call_1",
        duration: 12,
        result: { output: "hi" },
      });
      yield* harness.offerTurnEvent("turn.completed", {
        response: "done",
        tokenCount: 10,
        toolCallCount: 1,
        duration: 100,
        resultType: "success",
      });

      const started = yield* harness.takeEvent(
        "turn_item.updated",
        (event) =>
          event.turnItem.type === "command_execution" && event.turnItem.status === "running",
      );
      assert.equal(
        started.turnItem.type === "command_execution" ? started.turnItem.input : "",
        "echo hi",
      );
      const finished = yield* harness.takeEvent(
        "turn_item.updated",
        (event) =>
          event.turnItem.type === "command_execution" && event.turnItem.status === "completed",
      );
      assert.equal(
        finished.turnItem.type === "command_execution" ? finished.turnItem.output : "",
        "hi",
      );
      yield* harness.takeEvent("turn.terminal", (event) => event.status === "completed");
      assert.deepEqual(harness.scenario.unexpectedMethods(), []);
    }).pipe(Effect.scoped, Effect.provide(ZcodeAdapterTestLayer)),
  );

  it.effect("relays the exact scripted PermissionResponse to the broker request", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.startTurn();
      const allowResponse = { decision: "allow", reason: "Approved for this command" };
      yield* harness.offerTurnEvent("permission.requested", {
        requestId: "perm_1",
        toolCallId: "call_9",
        toolName: "Bash",
        riskLevel: "medium",
        reason: "Run a shell command",
        input: { command: "echo hi" },
        options: [
          {
            optionId: "allowOnce",
            kind: "allow_once",
            name: "Allow once",
            response: allowResponse,
          },
          {
            optionId: "deny",
            kind: "deny",
            name: "Deny",
            response: { decision: "deny", reason: "Denied by user" },
          },
        ],
      });
      // The broker request is delivered after the event but before the user answers; the
      // adapter must hold it open so the eventual answer still reaches zcode.
      const broker = zcodeServerRequest("interaction/requestPermission", {
        sessionId: harness.scenario.createdSessionId(),
        requestId: "perm_1",
        toolCallId: "call_9",
        reason: "Run a shell command",
        riskLevel: "medium",
      });
      yield* harness.scenario.offerEvent(broker);

      const requested = yield* harness.takeEvent(
        "runtime_request.updated",
        (event) => event.runtimeRequest.status === "pending",
      );
      assert.equal(requested.runtimeRequest.kind, "command");
      assert.equal(requested.runtimeRequest.nativeRequestRef?.nativeId, "perm_1");
      yield* harness.takeEvent(
        "turn_item.updated",
        (event) => event.turnItem.type === "approval_request",
      );

      yield* harness.runtime.respondToRuntimeRequest({
        requestId: requested.runtimeRequest.id,
        decision: "accept",
      });

      const relayed = harness.scenario.responds.find((respond) => respond.id === broker.id);
      assert.isDefined(relayed);
      assert.deepEqual(relayed!.result, allowResponse);
      yield* harness.takeEvent(
        "runtime_request.updated",
        (event) => event.runtimeRequest.status === "resolved",
      );
      yield* harness.offerTurnEvent("turn.completed", {
        response: "done",
        tokenCount: 3,
        toolCallCount: 1,
        duration: 80,
        resultType: "success",
      });
      yield* harness.takeEvent("turn.terminal", (event) => event.status === "completed");
      assert.deepEqual(harness.scenario.unexpectedMethods(), []);
    }).pipe(Effect.scoped, Effect.provide(ZcodeAdapterTestLayer)),
  );

  it.effect("interrupts via session/stop and reports the cancelled result as interrupted", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.startTurn();
      const running = yield* harness.takeEvent(
        "provider_turn.updated",
        (event) => event.providerTurn.status === "running",
      );
      yield* harness.runtime.interruptTurn({
        providerThread: harness.providerThread,
        providerTurnId: running.providerTurn.id,
      });
      const stop = requestFor(harness.scenario, "session/stop");
      assert.isDefined(stop);
      assert.equal(stop!.params["sessionId"], "sess_1");
      yield* harness.offerTurnEvent("turn.completed", {
        response: "",
        tokenCount: 5,
        toolCallCount: 0,
        duration: 50,
        resultType: "cancelled",
      });
      yield* harness.takeEvent("turn.terminal", (event) => event.status === "interrupted");
      assert.deepEqual(harness.scenario.unexpectedMethods(), []);
    }).pipe(Effect.scoped, Effect.provide(ZcodeAdapterTestLayer)),
  );
});
