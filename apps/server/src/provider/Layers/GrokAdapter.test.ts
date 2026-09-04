// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  ApprovalRequestId,
  GrokSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import {
  grokPromptSettlementBelongsToContext,
  isGrokEnterPlanModeToolCall,
  makeGrokAdapter,
  nextGrokPlanModeActive,
  selectGrokPermissionOptionId,
} from "./GrokAdapter.ts";
const decodeGrokSettings = Schema.decodeSync(GrokSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const mockAgentCommand = process.execPath;

async function makeMockGrokWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-acp-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-grok.sh");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
exec ${JSON.stringify(mockAgentCommand)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

function waitForFileContent(
  filePath: string,
  attempts = 40,
  expectedContent?: string,
): Effect.Effect<string> {
  const readAttempt = (remainingAttempts: number): Effect.Effect<string> =>
    Effect.gen(function* () {
      if (remainingAttempts <= 0) {
        return yield* Effect.die(new Error(`Timed out waiting for file content at ${filePath}`));
      }
      const raw = yield* Effect.tryPromise(() => NodeFSP.readFile(filePath, "utf8")).pipe(
        Effect.orElseSucceed(() => ""),
      );
      if (
        raw.trim().length > 0 &&
        (expectedContent === undefined || raw.includes(expectedContent))
      ) {
        return raw;
      }
      yield* Effect.sleep("25 millis");
      return yield* readAttempt(remainingAttempts - 1);
    });
  return readAttempt(attempts);
}

async function readJsonLines(filePath: string) {
  const raw = await NodeFSP.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const grokAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-grok-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (binaryPath: string, options?: Parameters<typeof makeGrokAdapter>[1]) =>
  makeGrokAdapter(decodeGrokSettings({ binaryPath }), options).pipe(Effect.orDie);

it("detects enter_plan_mode tool calls from title and rawInput", () => {
  assert.isTrue(
    isGrokEnterPlanModeToolCall({
      title: "enter_plan_mode",
      data: { toolCallId: "1" },
    }),
  );
  assert.isTrue(
    isGrokEnterPlanModeToolCall({
      title: "Plan mode entered",
      data: { toolCallId: "1", rawInput: { variant: "EnterPlanMode" } },
    }),
  );
  assert.isFalse(
    isGrokEnterPlanModeToolCall({
      title: "write",
      data: { toolCallId: "1", rawInput: { file_path: "/tmp/x", content: "y" } },
    }),
  );
});

it("only sets planModeActive after a successful enter_plan_mode", () => {
  const enter = {
    title: "enter_plan_mode",
    data: { toolCallId: "1" },
  };
  assert.isFalse(nextGrokPlanModeActive(false, { ...enter, status: "pending" }));
  assert.isTrue(nextGrokPlanModeActive(false, { ...enter, status: "inProgress" }));
  assert.isTrue(nextGrokPlanModeActive(false, { ...enter, status: "completed" }));
  assert.isFalse(nextGrokPlanModeActive(false, { ...enter, status: "failed" }));
  assert.isFalse(nextGrokPlanModeActive(true, { ...enter, status: "failed" }));
  assert.isTrue(
    nextGrokPlanModeActive(true, {
      title: "write",
      status: "completed",
      data: { toolCallId: "2" },
    }),
  );
});

function grokPermissionRequest(
  options: ReadonlyArray<{
    readonly optionId: string;
    readonly kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
  }>,
) {
  return {
    sessionId: "mock-session-1",
    toolCall: {
      toolCallId: "tool-call-1",
      title: "cat package.json",
      kind: "execute" as const,
      status: "pending" as const,
    },
    options: options.map((option) => ({
      optionId: option.optionId,
      name: option.kind,
      kind: option.kind,
    })),
  };
}

it("maps Always allow to allow_once when Grok omits allow_always", () => {
  const request = grokPermissionRequest([
    { optionId: "allow-once", kind: "allow_once" },
    { optionId: "reject-once", kind: "reject_once" },
  ]);

  assert.equal(selectGrokPermissionOptionId(request, "acceptForSession"), "allow-once");
  assert.equal(selectGrokPermissionOptionId(request, "accept"), "allow-once");
  assert.equal(selectGrokPermissionOptionId(request, "decline"), "reject-once");
});

it("prefers allow_always when Grok offers it", () => {
  const request = grokPermissionRequest([
    { optionId: "allow-once", kind: "allow_once" },
    { optionId: "allow-always", kind: "allow_always" },
    { optionId: "reject-once", kind: "reject_once" },
  ]);

  assert.equal(selectGrokPermissionOptionId(request, "acceptForSession"), "allow-always");
  assert.equal(selectGrokPermissionOptionId(request, "accept"), "allow-once");
});

it("requires a settlement to match the live Grok turn", () => {
  const staleTurnId = TurnId.make("stale-turn");
  const replacementTurnId = TurnId.make("replacement-turn");

  assert.isFalse(
    grokPromptSettlementBelongsToContext({
      liveAcpSessionId: "session-1",
      expectedAcpSessionId: "session-1",
      liveActiveTurnId: replacementTurnId,
      liveSessionActiveTurnId: replacementTurnId,
      turnId: staleTurnId,
    }),
  );
  assert.isFalse(
    grokPromptSettlementBelongsToContext({
      liveAcpSessionId: "replacement-session",
      expectedAcpSessionId: "stale-session",
      liveActiveTurnId: staleTurnId,
      liveSessionActiveTurnId: staleTurnId,
      turnId: staleTurnId,
    }),
  );
  assert.isTrue(
    grokPromptSettlementBelongsToContext({
      liveAcpSessionId: "session-1",
      expectedAcpSessionId: "session-1",
      liveActiveTurnId: staleTurnId,
      liveSessionActiveTurnId: staleTurnId,
      turnId: staleTurnId,
    }),
  );
});

it.layer(grokAdapterTestLayer)("GrokAdapterLive", (it) => {
  it.effect("sends runtime context with the current model without changing saved prompts", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-runtime-context");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-runtime-context-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-mock-alt" },
      });
      yield* adapter.sendTurn({ threadId, input: "First prompt" });
      yield* adapter.sendTurn({
        threadId,
        input: "Second prompt",
        modelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-4.6",
          options: [{ id: "reasoningEffort", value: "low" }],
        },
      });
      const snapshot = yield* adapter.readThread(threadId);
      assert.deepEqual(
        snapshot.turns.map((turn) => turn.items),
        [
          [
            {
              prompt: [{ type: "text", text: "First prompt" }],
              result: { stopReason: "end_turn" },
            },
          ],
          [
            {
              prompt: [{ type: "text", text: "Second prompt" }],
              result: { stopReason: "end_turn" },
            },
          ],
        ],
      );
      yield* adapter.stopSession(threadId);
      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const prompts = requests
        .filter((request) => request.method === "session/prompt")
        .map(
          (request) => (request.params as { prompt: Array<{ type: string; text: string }> }).prompt,
        );
      assert.equal(prompts.length, 2);
      assert.deepEqual(prompts[0]?.[0], { type: "text", text: "First prompt" });
      assert.include(prompts[0]?.[1]?.text, "Grok harness, as grok-mock-alt");
      assert.deepEqual(prompts[1]?.[0], { type: "text", text: "Second prompt" });
      assert.include(prompts[1]?.[1]?.text, "Grok harness, as grok-4.6");
      assert.include(prompts[1]?.[1]?.text, "with low reasoning effort");
      assert.include(prompts[1]?.[1]?.text, "embed images and videos");
    }),
  );

  it.effect("starts a session and maps mock ACP prompt flow to runtime events", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-mock-thread");
      const wrapperPath = yield* Effect.promise(() => makeMockGrokWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-mock-alt" },
      });

      assert.equal(session.provider, "grok");
      assert.equal(session.model, "grok-mock-alt");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "hello grok",
        attachments: [],
      });

      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);
      const types = runtimeEvents.map((e) => e.type);

      assert.includeMembers(types, [
        "session.started",
        "session.state.changed",
        "thread.started",
        "turn.started",
        "item.started",
        "content.delta",
        "turn.completed",
      ] as const);

      const delta = runtimeEvents.find((e) => e.type === "content.delta");
      assert.isDefined(delta);
      if (delta?.type === "content.delta") {
        assert.equal(delta.payload.delta, "hello from mock");
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("closes the ACP child process when a session stops", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-stop-session-close");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-adapter-exit-log-")),
      );
      const exitLogPath = NodePath.join(tempDir, "exit.log");

      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EXIT_LOG_PATH: exitLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
      });

      yield* adapter.stopSession(threadId);

      const exitLog = yield* waitForFileContent(exitLogPath);
      assert.include(exitLog, "SIGTERM");
    }),
  );

  it.effect("reports a Grok session running only while the prompt is in flight", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-session-ready-after-prompt");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EMIT_TOOL_CALLS: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const requestOpened =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "request.opened" }>>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "request.opened"
          ? Deferred.succeed(requestOpened, event).pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "check lifecycle", attachments: [] })
        .pipe(Effect.forkChild);
      const requestOpenedEvent = yield* Deferred.await(requestOpened);

      const runningSessions = yield* adapter.listSessions();
      const runningSession = runningSessions.find((session) => session.threadId === threadId);
      assert.equal(runningSession?.status, "running");
      assert.isDefined(runningSession?.activeTurnId);

      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(String(requestOpenedEvent.requestId)),
        "accept",
      );
      yield* Fiber.join(sendTurnFiber);

      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("restores ready without completing an unstarted turn when preparation fails", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-preparation-failure-while-connecting");
      const wrapperPath = yield* Effect.promise(() => makeMockGrokWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
      });

      const error = yield* Effect.flip(
        adapter.sendTurn({
          threadId,
          input: "prepare invalid attachment",
          attachments: [
            {
              type: "image",
              id: "missing-image",
              name: "missing.png",
              mimeType: "image/png",
              sizeBytes: 1,
            },
          ],
        }),
      );
      for (let yieldAttempt = 0; yieldAttempt < 4; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }

      const turnCompletedEvent = runtimeEvents.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed",
      );
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);

      assert.equal(error._tag, "ProviderAdapterRequestError");
      assert.isUndefined(turnCompletedEvent);
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("completes a Grok turn from xAI prompt completion when the prompt RPC hangs", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-xai-prompt-complete-fallback");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EMIT_XAI_PROMPT_COMPLETE_THEN_HANG: "1",
          T3_ACP_EMIT_FOREIGN_SESSION_UPDATES: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
      });

      const sendTurnResult = yield* adapter.sendTurn({
        threadId,
        input: "exercise fallback",
        attachments: [],
      });

      yield* Deferred.await(turnCompleted);
      for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);
      const turnCompletedEvent = runtimeEvents.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed",
      );
      const eventTypes = runtimeEvents.map((event) => event.type);
      const content = runtimeEvents
        .filter(
          (event): event is Extract<ProviderRuntimeEvent, { type: "content.delta" }> =>
            event.type === "content.delta" && String(event.threadId) === String(threadId),
        )
        .map((event) => event.payload.delta)
        .join("");
      const terminalIndex = runtimeEvents.findIndex(
        (event) => event.type === "turn.completed" && String(event.threadId) === String(threadId),
      );
      const turnOutputTypes = new Set([
        "content.delta",
        "item.started",
        "item.updated",
        "item.completed",
        "turn.plan.updated",
      ]);
      const outputAfterTerminal = runtimeEvents
        .slice(terminalIndex + 1)
        .filter(
          (event) => String(event.threadId) === String(threadId) && turnOutputTypes.has(event.type),
        );
      const toolTitles = runtimeEvents.flatMap((event) =>
        event.type === "item.updated" && event.payload.title ? [event.payload.title] : [],
      );

      assert.equal(sendTurnResult.threadId, threadId);
      assert.include(eventTypes, "turn.completed");
      assert.equal(content, "hello from mock");
      assert.isAtLeast(terminalIndex, 0);
      assert.deepEqual(outputAfterTerminal, []);
      assert.notInclude(toolTitles, "Child-only tool");
      assert.equal(turnCompletedEvent?.payload.stopReason, "end_turn");
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("does not time out a Grok turn before ACP emits progress", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-watchdog-silent-turn");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_HANG_PROMPT_FOREVER: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath, {
        turnInactivityTimeoutMs: 1_000,
      });
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnStarted = yield* Deferred.make<void>();
      const turnCompleted =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          runtimeEvents.push(event);
          if (event.type === "turn.started") {
            yield* Deferred.succeed(turnStarted, undefined).pipe(Effect.ignore);
          }
          if (event.type === "turn.completed") {
            yield* Deferred.succeed(turnCompleted, event).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "silence forever", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(turnStarted);

      yield* TestClock.adjust("5 seconds");
      yield* Effect.yieldNow;
      const steerSendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "keep reasoning", attachments: [] })
        .pipe(Effect.forkChild);
      for (let yieldAttempt = 0; yieldAttempt < 12; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }
      yield* TestClock.adjust("5 seconds");
      yield* Effect.yieldNow;
      assert.lengthOf(
        runtimeEvents.filter(
          (event) => event.type === "turn.completed" && String(event.threadId) === String(threadId),
        ),
        0,
      );

      yield* adapter.interruptTurn(threadId);
      const completed = yield* Deferred.await(turnCompleted).pipe(
        Effect.timeout("2 seconds"),
        TestClock.withLive,
      );
      yield* Fiber.join(sendTurnFiber);
      yield* Fiber.interrupt(steerSendTurnFiber);

      assert.equal(completed.payload.state, "cancelled");
      const session = (yield* adapter.listSessions()).find(
        (candidate) => candidate.threadId === threadId,
      );
      assert.equal(session?.status, "ready");
      assert.isUndefined(session?.activeTurnId);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("fails a Grok turn that stalls after ACP content begins", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-watchdog-content-stall");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EMIT_CONTENT_THEN_HANG: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath, {
        turnInactivityTimeoutMs: 1_000,
      });
      const contentDelta = yield* Deferred.make<void>();
      const turnCompleted =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>>();
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          runtimeEvents.push(event);
          if (event.type === "content.delta") {
            yield* Deferred.succeed(contentDelta, undefined).pipe(Effect.ignore);
          }
          if (event.type === "turn.completed") {
            yield* Deferred.succeed(turnCompleted, event).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "start then stall", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(contentDelta).pipe(Effect.timeout("2 seconds"), TestClock.withLive);

      yield* TestClock.adjust("999 millis");
      yield* Effect.yieldNow;
      assert.lengthOf(
        runtimeEvents.filter(
          (event) => event.type === "turn.completed" && String(event.threadId) === String(threadId),
        ),
        0,
      );

      yield* TestClock.adjust("1 millis");
      for (let yieldAttempt = 0; yieldAttempt < 4; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }
      const completed = yield* Deferred.await(turnCompleted).pipe(
        Effect.timeout("2 seconds"),
        TestClock.withLive,
      );
      yield* Fiber.join(sendTurnFiber);

      assert.equal(completed.payload.state, "failed");
      assert.equal(
        runtimeEvents.filter(
          (event) => event.type === "turn.completed" && String(event.threadId) === String(threadId),
        ).length,
        1,
      );

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("refreshes Grok liveness when a turn is steered", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-watchdog-steer");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EMIT_CONTENT_THEN_HANG: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath, {
        turnInactivityTimeoutMs: 1_000,
      });
      const contentDelta = yield* Deferred.make<void>();
      const turnCompleted =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>>();
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          runtimeEvents.push(event);
          if (event.type === "content.delta") {
            yield* Deferred.succeed(contentDelta, undefined).pipe(Effect.ignore);
          }
          if (event.type === "turn.completed") {
            yield* Deferred.succeed(turnCompleted, event).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const firstSendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "start then steer", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(contentDelta).pipe(Effect.timeout("2 seconds"), TestClock.withLive);

      yield* TestClock.adjust("999 millis");
      const steerSendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "continue working", attachments: [] })
        .pipe(Effect.forkChild);
      for (let yieldAttempt = 0; yieldAttempt < 12; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }

      yield* TestClock.adjust("1 millis");
      for (let yieldAttempt = 0; yieldAttempt < 4; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }
      assert.lengthOf(
        runtimeEvents.filter(
          (event) => event.type === "turn.completed" && String(event.threadId) === String(threadId),
        ),
        0,
      );

      yield* adapter.interruptTurn(threadId);
      const completed = yield* Deferred.await(turnCompleted).pipe(
        Effect.timeout("2 seconds"),
        TestClock.withLive,
      );
      yield* Fiber.join(firstSendTurnFiber);
      yield* Fiber.interrupt(steerSendTurnFiber);
      assert.equal(completed.payload.state, "cancelled");

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("refreshes Grok liveness when ACP updates its plan", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-watchdog-plan-stall");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EMIT_PLAN_THEN_HANG: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath, {
        turnInactivityTimeoutMs: 1_000,
      });
      const planUpdated = yield* Deferred.make<void>();
      const turnCompleted =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          if (event.type === "turn.plan.updated") {
            yield* Deferred.succeed(planUpdated, undefined).pipe(Effect.ignore);
          }
          if (event.type === "turn.completed") {
            yield* Deferred.succeed(turnCompleted, event).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "update plan then stall", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(planUpdated).pipe(Effect.timeout("2 seconds"), TestClock.withLive);

      yield* TestClock.adjust("1 second");
      for (let yieldAttempt = 0; yieldAttempt < 4; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }
      const completed = yield* Deferred.await(turnCompleted).pipe(
        Effect.timeout("2 seconds"),
        TestClock.withLive,
      );
      yield* Fiber.join(sendTurnFiber);

      assert.equal(completed.payload.state, "failed");
      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("settles a stalled Grok turn after the active-tool deadline", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-watchdog-active-tool");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EMIT_ACTIVE_TOOL_THEN_HANG: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath, {
        turnInactivityTimeoutMs: 1_000,
        activeToolInactivityTimeoutMs: 5_000,
      });
      const activeTool = yield* Deferred.make<void>();
      const turnCompleted =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>>();
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          runtimeEvents.push(event);
          if (event.type === "item.updated") {
            yield* Deferred.succeed(activeTool, undefined).pipe(Effect.ignore);
          }
          if (event.type === "turn.completed") {
            yield* Deferred.succeed(turnCompleted, event).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "run a long tool", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(activeTool).pipe(Effect.timeout("2 seconds"), TestClock.withLive);
      for (let yieldAttempt = 0; yieldAttempt < 4; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }

      yield* TestClock.adjust("4999 millis");
      yield* Effect.yieldNow;
      assert.lengthOf(
        runtimeEvents.filter(
          (event) => event.type === "turn.completed" && String(event.threadId) === String(threadId),
        ),
        0,
      );
      assert.equal(
        (yield* adapter.listSessions()).find((candidate) => candidate.threadId === threadId)
          ?.status,
        "running",
      );

      yield* TestClock.adjust("1 millis");
      for (let yieldAttempt = 0; yieldAttempt < 4; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }
      const completed = yield* Deferred.await(turnCompleted).pipe(
        Effect.timeout("2 seconds"),
        TestClock.withLive,
      );
      yield* Fiber.join(sendTurnFiber);
      assert.equal(completed.payload.state, "failed");

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("retains turn transcript when sendTurn is interrupted after prompt success", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-send-turn-interrupt-after-prompt");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EMIT_XAI_PROMPT_COMPLETE_THEN_HANG: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const contentDelta = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "content.delta" ? Deferred.succeed(contentDelta, undefined) : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "interrupt after prompt",
          attachments: [],
        })
        .pipe(Effect.forkChild);

      yield* Deferred.await(contentDelta);
      for (let yieldAttempt = 0; yieldAttempt < 6; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }
      yield* Fiber.interrupt(sendTurnFiber);
      for (let yieldAttempt = 0; yieldAttempt < 4; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }

      const snapshot = yield* adapter.readThread(threadId);
      assert.equal(snapshot.turns.length, 1);
      assert.equal(snapshot.turns[0]?.items.length, 1);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("does not report a synthetic stop reason when xAI omits one", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-xai-prompt-complete-missing-stop-reason");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EMIT_XAI_PROMPT_COMPLETE_THEN_HANG: "1",
          T3_ACP_OMIT_XAI_PROMPT_COMPLETE_STOP_REASON: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "exercise missing stop reason",
        attachments: [],
      });

      yield* Deferred.await(turnCompleted);
      const turnCompletedEvent = runtimeEvents.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed",
      );

      assert.equal(turnCompletedEvent?.payload.state, "completed");
      assert.isNull(turnCompletedEvent?.payload.stopReason);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("lets Stop unblock a fully silent Grok prompt and accept a follow-up turn", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-stop-after-full-silence");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_HANG_FIRST_PROMPT_FOREVER: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
      });

      yield* Effect.gen(function* () {
        yield* Effect.sleep("500 millis");
        yield* adapter.interruptTurn(threadId);
      }).pipe(Effect.forkChild({ startImmediately: true }));

      yield* adapter.sendTurn({
        threadId,
        input: "hang forever",
        attachments: [],
      });
      for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }

      const cancelledEvents = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed" && String(event.threadId) === String(threadId),
      );
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);

      assert.lengthOf(cancelledEvents, 1);
      assert.equal(cancelledEvents[0]?.payload.state, "cancelled");
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      const followUpEventsBefore = runtimeEvents.length;
      yield* adapter.sendTurn({
        threadId,
        input: "continue after stop",
        attachments: [],
      });
      for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }

      const followUpCompletedEvents = runtimeEvents
        .slice(followUpEventsBefore)
        .filter(
          (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
            event.type === "turn.completed" && String(event.threadId) === String(threadId),
        );
      assert.lengthOf(followUpCompletedEvents, 1);
      assert.equal(followUpCompletedEvents[0]?.payload.state, "completed");

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("does not let a cancelled prompt settlement consume the follow-up prompt slot", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-cancelled-settlement-before-follow-up");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-acp-cancel-race-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_HANG_FIRST_PROMPT_FOREVER: "1",
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const firstTurnStarted = yield* Deferred.make<TurnId>();
      const twoTurnsCompleted = yield* Deferred.make<void>();
      const completedCountRef = yield* Ref.make(0);
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          if (event.type === "turn.started" && event.turnId !== undefined) {
            yield* Deferred.succeed(firstTurnStarted, event.turnId).pipe(Effect.ignore);
            return;
          }
          if (event.type !== "turn.completed") {
            return;
          }
          const completedCount = yield* Ref.updateAndGet(completedCountRef, (count) => count + 1);
          if (completedCount === 2) {
            yield* Deferred.succeed(twoTurnsCompleted, undefined);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const firstSendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "cancel this prompt", attachments: [] })
        .pipe(Effect.forkChild);
      const firstTurnId = yield* Deferred.await(firstTurnStarted).pipe(Effect.timeout("2 seconds"));
      yield* waitForFileContent(requestLogPath, 80, '"method":"session/prompt"');

      yield* adapter.interruptTurn(threadId, firstTurnId).pipe(Effect.timeout("2 seconds"));
      const followUp = yield* adapter
        .sendTurn({ threadId, input: "complete the follow-up", attachments: [] })
        .pipe(Effect.timeout("2 seconds"));
      yield* Fiber.join(firstSendTurnFiber).pipe(Effect.timeout("2 seconds"));
      yield* Deferred.await(twoTurnsCompleted).pipe(Effect.timeout("2 seconds"));

      const turnCompletedEvents = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed" && String(event.threadId) === String(threadId),
      );
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);

      assert.notEqual(String(followUp.turnId), String(firstTurnId));
      assert.deepEqual(
        turnCompletedEvents.map((event) => [String(event.turnId), event.payload.state]),
        [
          [String(firstTurnId), "cancelled"],
          [String(followUp.turnId), "completed"],
        ],
      );
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("cancels an in-flight prompt when a mid-turn sendTurn steers", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-steer-cancels-in-flight");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-acp-steer-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_HANG_FIRST_PROMPT_FOREVER: "1",
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const firstTurnStarted = yield* Deferred.make<TurnId>();
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          if (event.type === "turn.started" && event.turnId !== undefined) {
            yield* Deferred.succeed(firstTurnStarted, event.turnId).pipe(Effect.ignore);
            return;
          }
          if (event.type === "turn.completed") {
            yield* Deferred.succeed(turnCompleted, undefined).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const firstSendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "hang until steered", attachments: [] })
        .pipe(Effect.forkChild);
      const firstTurnId = yield* Deferred.await(firstTurnStarted).pipe(Effect.timeout("2 seconds"));
      yield* waitForFileContent(requestLogPath, 80, '"method":"session/prompt"');

      const steered = yield* adapter
        .sendTurn({ threadId, input: "take this instead", attachments: [] })
        .pipe(Effect.timeout("3 seconds"));
      yield* Fiber.join(firstSendTurnFiber).pipe(Effect.timeout("3 seconds"));
      yield* Deferred.await(turnCompleted).pipe(Effect.timeout("3 seconds"));

      const requestLog = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const methods = requestLog.flatMap((entry) =>
        typeof entry.method === "string" ? [entry.method] : [],
      );
      const turnStartedEvents = runtimeEvents.filter(
        (event) => event.type === "turn.started" && String(event.threadId) === String(threadId),
      );
      const turnCompletedEvents = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed" && String(event.threadId) === String(threadId),
      );
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);

      assert.equal(String(steered.turnId), String(firstTurnId));
      assert.isTrue(methods.includes("session/cancel"));
      assert.isAtLeast(methods.filter((method) => method === "session/prompt").length, 2);
      assert.lengthOf(turnStartedEvents, 1);
      assert.lengthOf(turnCompletedEvents, 1);
      assert.equal(turnCompletedEvents[0]?.payload.state, "completed");
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect(
    "steers a prompt that has not started ACP yet instead of letting it start after cancel",
    () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("grok-steer-during-prep");
        const tempDir = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-acp-steer-prep-")),
        );
        const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
        const wrapperPath = yield* Effect.promise(() =>
          makeMockGrokWrapper({
            T3_ACP_HANG_FIRST_PROMPT_FOREVER: "1",
            T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          }),
        );
        const adapter = yield* makeTestAdapter(wrapperPath);

        const runtimeEvents: ProviderRuntimeEvent[] = [];
        const firstTurnStarted = yield* Deferred.make<TurnId>();
        const turnCompleted = yield* Deferred.make<void>();
        const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.gen(function* () {
            runtimeEvents.push(event);
            if (String(event.threadId) !== String(threadId)) {
              return;
            }
            if (event.type === "turn.started" && event.turnId !== undefined) {
              yield* Deferred.succeed(firstTurnStarted, event.turnId).pipe(Effect.ignore);
              return;
            }
            if (event.type === "turn.completed") {
              yield* Deferred.succeed(turnCompleted, undefined).pipe(Effect.ignore);
            }
          }),
        ).pipe(Effect.forkChild);

        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("grok"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });

        const firstSendTurnFiber = yield* adapter
          .sendTurn({ threadId, input: "still preparing", attachments: [] })
          .pipe(Effect.forkChild);
        const firstTurnId = yield* Deferred.await(firstTurnStarted).pipe(
          Effect.timeout("2 seconds"),
        );

        const steered = yield* adapter
          .sendTurn({ threadId, input: "steer before first prompt starts", attachments: [] })
          .pipe(Effect.timeout("3 seconds"));
        yield* Fiber.join(firstSendTurnFiber).pipe(Effect.timeout("3 seconds"));
        yield* Deferred.await(turnCompleted).pipe(Effect.timeout("3 seconds"));

        const turnCompletedEvents = runtimeEvents.filter(
          (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
            event.type === "turn.completed" && String(event.threadId) === String(threadId),
        );
        const readySessions = yield* adapter.listSessions();
        const readySession = readySessions.find((session) => session.threadId === threadId);

        assert.equal(String(steered.turnId), String(firstTurnId));
        assert.lengthOf(turnCompletedEvents, 1);
        assert.equal(turnCompletedEvents[0]?.payload.state, "completed");
        assert.equal(readySession?.status, "ready");
        assert.isUndefined(readySession?.activeTurnId);

        yield* Fiber.interrupt(runtimeEventsFiber);
        yield* adapter.stopSession(threadId);
      }).pipe(TestClock.withLive),
  );

  it.effect("keeps the original prompt running when a steer fails during preparation", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-failed-steer-keeps-original-prompt");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-acp-failed-steer-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_HANG_FIRST_PROMPT_FOREVER: "1",
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const firstTurnStarted = yield* Deferred.make<TurnId>();
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          if (event.type === "turn.started" && event.turnId !== undefined) {
            yield* Deferred.succeed(firstTurnStarted, event.turnId).pipe(Effect.ignore);
            return;
          }
          if (event.type === "turn.completed") {
            yield* Deferred.succeed(turnCompleted, undefined).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const firstSendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "hang until a failed steer", attachments: [] })
        .pipe(Effect.forkChild);
      const firstTurnId = yield* Deferred.await(firstTurnStarted).pipe(Effect.timeout("2 seconds"));

      const steerError = yield* Effect.flip(
        adapter.sendTurn({
          threadId,
          input: "   ",
          attachments: [],
        }),
      );
      yield* waitForFileContent(requestLogPath, 80, '"method":"session/prompt"');
      for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }

      const sessionsAfterFailedSteer = yield* adapter.listSessions();
      const sessionAfterFailedSteer = sessionsAfterFailedSteer.find(
        (session) => session.threadId === threadId,
      );
      const completedBeforeInterrupt = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed" && String(event.threadId) === String(threadId),
      );

      yield* adapter.interruptTurn(threadId, firstTurnId).pipe(Effect.timeout("2 seconds"));
      yield* Fiber.join(firstSendTurnFiber).pipe(Effect.timeout("3 seconds"));
      yield* Deferred.await(turnCompleted).pipe(Effect.timeout("3 seconds"));

      const turnCompletedEvents = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed" && String(event.threadId) === String(threadId),
      );
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);

      assert.equal(steerError._tag, "ProviderAdapterValidationError");
      assert.equal(sessionAfterFailedSteer?.status, "running");
      assert.equal(String(sessionAfterFailedSteer?.activeTurnId), String(firstTurnId));
      assert.lengthOf(completedBeforeInterrupt, 0);
      assert.lengthOf(turnCompletedEvents, 1);
      assert.equal(String(turnCompletedEvents[0]?.turnId), String(firstTurnId));
      assert.equal(turnCompletedEvents[0]?.payload.state, "cancelled");
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("does not double-complete when interrupt wins before a prompt starts ACP", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-interrupt-before-prompt-start");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_HANG_FIRST_PROMPT_FOREVER: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const firstTurnStarted = yield* Deferred.make<TurnId>();
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          if (event.type === "turn.started" && event.turnId !== undefined) {
            yield* Deferred.succeed(firstTurnStarted, event.turnId).pipe(Effect.ignore);
            return;
          }
          if (event.type === "turn.completed") {
            yield* Deferred.succeed(turnCompleted, undefined).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const firstSendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "interrupt before prompt starts", attachments: [] })
        .pipe(Effect.forkChild);
      const firstTurnId = yield* Deferred.await(firstTurnStarted).pipe(Effect.timeout("2 seconds"));
      yield* adapter.interruptTurn(threadId, firstTurnId).pipe(Effect.timeout("2 seconds"));
      yield* Fiber.join(firstSendTurnFiber).pipe(Effect.timeout("3 seconds"));
      yield* Deferred.await(turnCompleted).pipe(Effect.timeout("3 seconds"));

      const turnCompletedEvents = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed" && String(event.threadId) === String(threadId),
      );
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);

      assert.lengthOf(turnCompletedEvents, 1);
      assert.equal(String(turnCompletedEvents[0]?.turnId), String(firstTurnId));
      assert.equal(turnCompletedEvents[0]?.payload.state, "cancelled");
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("drops late ACP notifications after a turn is cancelled", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-drop-late-cancelled-notifications");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_HANG_PROMPT_FOREVER: "1",
          T3_ACP_EMIT_LATE_UPDATE_AFTER_CANCEL: "1",
        }),
      );
      const lateNativeUpdate = yield* Deferred.make<void>();
      const adapter = yield* makeTestAdapter(wrapperPath, {
        nativeEventLogger: {
          filePath: "memory://grok-cancelled-native-events",
          write: (record: unknown) =>
            JSON.stringify(record).includes("late after cancel")
              ? Deferred.succeed(lateNativeUpdate, undefined).pipe(Effect.asVoid)
              : Effect.void,
          close: () => Effect.void,
        },
      });

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnStarted = yield* Deferred.make<TurnId>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.started" &&
              event.turnId !== undefined &&
              String(event.threadId) === String(threadId)
              ? Deferred.succeed(turnStarted, event.turnId).pipe(Effect.asVoid)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "cancel before the late update", attachments: [] })
        .pipe(Effect.forkChild);
      const turnId = yield* Deferred.await(turnStarted).pipe(Effect.timeout("2 seconds"));
      yield* adapter.interruptTurn(threadId, turnId).pipe(Effect.timeout("2 seconds"));
      yield* Fiber.join(sendTurnFiber).pipe(Effect.timeout("2 seconds"));
      yield* Deferred.await(lateNativeUpdate).pipe(Effect.timeout("2 seconds"));
      for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }

      const cancelledIndex = runtimeEvents.findIndex(
        (event) =>
          event.type === "turn.completed" &&
          String(event.threadId) === String(threadId) &&
          String(event.turnId) === String(turnId) &&
          event.payload.state === "cancelled",
      );
      const turnOutputTypes = new Set([
        "content.delta",
        "item.started",
        "item.updated",
        "item.completed",
        "turn.plan.updated",
      ]);
      const outputAfterCancellation = runtimeEvents
        .slice(cancelledIndex + 1)
        .filter(
          (event) => String(event.threadId) === String(threadId) && turnOutputTypes.has(event.type),
        );

      assert.isAtLeast(cancelledIndex, 0);
      assert.deepEqual(outputAfterCancellation, []);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("lets Stop cancel during the xAI completion drain window", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-stop-during-completion-drain");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EMIT_XAI_PROMPT_COMPLETE_THEN_HANG: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const activeTurnIdRef = yield* Ref.make<TurnId | undefined>(undefined);
      const trailingChunkTurnId = yield* Deferred.make<TurnId>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          if (event.type === "turn.started") {
            yield* Ref.set(activeTurnIdRef, event.turnId);
          }
          if (event.type !== "content.delta" || event.payload.delta !== "mock") {
            return;
          }
          const turnId = event.turnId ?? (yield* Ref.get(activeTurnIdRef));
          if (turnId === undefined) {
            return;
          }
          yield* Deferred.succeed(trailingChunkTurnId, turnId).pipe(Effect.ignore);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "cancel during completion drain",
          attachments: [],
        })
        .pipe(Effect.forkChild);

      const turnId = yield* Deferred.await(trailingChunkTurnId).pipe(Effect.timeout("2 seconds"));
      yield* adapter.interruptTurn(threadId, turnId).pipe(Effect.timeout("2 seconds"));
      yield* Fiber.join(sendTurnFiber).pipe(Effect.timeout("2 seconds"));

      const turnCompletedEvents = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed" && String(event.threadId) === String(threadId),
      );
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);

      assert.lengthOf(turnCompletedEvents, 1);
      assert.equal(turnCompletedEvents[0]?.payload.state, "cancelled");
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("settles the in-flight prompt before emitting completion", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-completion-before-next-turn");
      const wrapperPath = yield* Effect.promise(() => makeMockGrokWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);
      const completedCountRef = yield* Ref.make(0);
      const secondTurnCompleted = yield* Deferred.make<void>();

      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (event.type !== "turn.completed" || String(event.threadId) !== String(threadId)) {
          return Effect.void;
        }

        return Ref.modify(completedCountRef, (count) => {
          const nextCount = count + 1;
          return [nextCount, nextCount] as const;
        }).pipe(
          Effect.flatMap((count) => {
            if (count === 1) {
              return adapter
                .sendTurn({
                  threadId,
                  input: "second turn after completion",
                  attachments: [],
                })
                .pipe(Effect.forkChild, Effect.asVoid);
            }
            if (count === 2) {
              return Deferred.succeed(secondTurnCompleted, undefined).pipe(Effect.asVoid);
            }
            return Effect.void;
          }),
        );
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "first turn",
        attachments: [],
      });
      yield* Deferred.await(secondTurnCompleted);

      const completedCount = yield* Ref.get(completedCountRef);
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);

      assert.equal(completedCount, 2);
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("restores a Grok session to ready when the prompt RPC fails", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-prompt-failure-ready");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_FAIL_PROMPT: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
      });

      const error = yield* Effect.flip(
        adapter.sendTurn({
          threadId,
          input: "fail prompt",
          attachments: [],
        }),
      );
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);
      const failedTurnCompleted = runtimeEvents.find(
        (event) => event.type === "turn.completed" && event.threadId === threadId,
      );

      assert.equal(error._tag, "ProviderAdapterRequestError");
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);
      assert.equal(failedTurnCompleted?.type, "turn.completed");
      if (failedTurnCompleted?.type === "turn.completed") {
        assert.equal(failedTurnCompleted.payload.state, "failed");
        assert.isString(failedTurnCompleted.payload.errorMessage);
      }

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("surfaces Grok usage limits without clearing the selected model", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-usage-limit-error");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EMIT_XAI_RATE_LIMIT_THEN_HANG: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
      });

      const error = yield* Effect.flip(
        adapter.sendTurn({
          threadId,
          input: "hit the usage limit",
          attachments: [],
        }),
      );
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);
      const terminalEvents = runtimeEvents.filter(
        (event) => event.type === "turn.completed" && event.threadId === threadId,
      );

      assert.equal(error._tag, "ProviderAdapterRequestError");
      assert.include(error.message, "Grok usage limit reached. Try again later.");
      assert.equal(readySession?.status, "ready");
      // "grok-build" resolves to the session's current model instead of going over the wire.
      assert.equal(readySession?.model, "grok-4.6");
      assert.isUndefined(readySession?.activeTurnId);
      assert.lengthOf(terminalEvents, 1);
      const [terminalEvent] = terminalEvents;
      assert.equal(terminalEvent?.type, "turn.completed");
      if (terminalEvent?.type === "turn.completed") {
        assert.equal(terminalEvent.payload.state, "failed");
        assert.include(
          terminalEvent.payload.errorMessage ?? "",
          "Grok usage limit reached. Try again later.",
        );
      }

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("ignores replayed session/load updates when resuming a Grok session", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-load-replay-filter");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EMIT_LOAD_REPLAY: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
        resumeCursor: { schemaVersion: 1, sessionId: "mock-session-1" },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "after resume",
        attachments: [],
      });

      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });
      assert.isFalse(
        runtimeEvents.some(
          (event) => event.type === "item.completed" && event.payload.title === "Replay tool",
        ),
      );
      assert.isFalse(
        runtimeEvents.some(
          (event) =>
            event.type === "content.delta" && event.payload.delta === "replayed assistant text",
        ),
      );

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("rejects startSession when provider mismatches", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() => makeMockGrokWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);
      const threadId = ThreadId.make("grok-provider-mismatch");

      const error = yield* Effect.flip(
        adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("cursor"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
        }),
      );

      assert.equal(error._tag, "ProviderAdapterValidationError");
    }),
  );

  it.effect("rejects sendTurn with empty input and no attachments", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-empty-turn");

      const wrapperPath = yield* Effect.promise(() => makeMockGrokWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
      });

      const error = yield* Effect.flip(
        adapter.sendTurn({
          threadId,
          input: "   ",
          attachments: [],
        }),
      );

      assert.equal(error._tag, "ProviderAdapterValidationError");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("responds to ACP approvals using provider-supplied option ids", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-custom-approval-option-id");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-acp-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_EMIT_TOOL_CALLS: "1",
          T3_ACP_ALLOW_ONCE_OPTION_ID: "agent-defined-approval-id",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "request.opened"
          ? adapter.respondToRequest(
              threadId,
              ApprovalRequestId.make(String(event.requestId)),
              "accept",
            )
          : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({ threadId, input: "approve this", attachments: [] });

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.isTrue(
        requests.some(
          (entry) =>
            !("method" in entry) &&
            typeof entry.result === "object" &&
            entry.result !== null &&
            "outcome" in entry.result &&
            typeof entry.result.outcome === "object" &&
            entry.result.outcome !== null &&
            "optionId" in entry.result.outcome &&
            entry.result.outcome.optionId === "agent-defined-approval-id",
        ),
      );

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("captures xAI exit_plan_mode as a proposed plan and unblocks the turn", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-xai-exit-plan-mode");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({ T3_ACP_EMIT_XAI_EXIT_PLAN_MODE: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const proposed =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "turn.proposed.completed" }>>();
      const turnCompleted = yield* Deferred.make<void>();

      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (String(event.threadId) !== String(threadId)) {
          return Effect.void;
        }
        if (event.type === "turn.proposed.completed") {
          return Deferred.succeed(proposed, event).pipe(Effect.ignore);
        }
        if (event.type === "turn.completed") {
          return Deferred.succeed(turnCompleted, undefined).pipe(Effect.ignore);
        }
        return Effect.void;
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({ threadId, input: "present the plan", attachments: [] });

      const proposedEvent = yield* Deferred.await(proposed);
      assert.equal(proposedEvent.type, "turn.proposed.completed");
      assert.equal(proposedEvent.payload.planMarkdown, "# Exit plan\n\n- Step one\n- Step two");
      assert.equal(proposedEvent.raw?.method, "_x.ai/exit_plan_mode");
      yield* Deferred.await(turnCompleted);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("surfaces plan.md writes as a proposed plan while plan mode is active", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-xai-plan-md-write");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({ T3_ACP_EMIT_XAI_PLAN_MD_WRITE: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const proposed =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "turn.proposed.completed" }>>();

      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (String(event.threadId) !== String(threadId)) {
          return Effect.void;
        }
        if (event.type === "turn.proposed.completed") {
          return Deferred.succeed(proposed, event).pipe(Effect.ignore);
        }
        return Effect.void;
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({ threadId, input: "write the plan", attachments: [] });

      const proposedEvent = yield* Deferred.await(proposed);
      assert.equal(
        proposedEvent.payload.planMarkdown,
        "# Mock plan\n\n- Write the feature\n- Add a test\n- Ship it",
      );
      assert.equal(proposedEvent.raw?.method, "session/update");

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("keeps a Grok turn running when Always allow has no allow_always option", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-always-allow-without-allow-always");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-acp-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_EMIT_TOOL_CALLS: "1",
          T3_ACP_OMIT_ALLOW_ALWAYS: "1",
          T3_ACP_PERMISSION_REQUEST_COUNT: "2",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const openedCount = yield* Ref.make(0);
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "request.opened"
          ? Effect.gen(function* () {
              yield* Ref.update(openedCount, (count) => count + 1);
              yield* adapter.respondToRequest(
                threadId,
                ApprovalRequestId.make(String(event.requestId)),
                "acceptForSession",
              );
            })
          : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "approve this session",
        attachments: [],
      });

      assert.equal(yield* Ref.get(openedCount), 1);

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const permissionResults = requests.filter(
        (entry) =>
          !("method" in entry) &&
          typeof entry.result === "object" &&
          entry.result !== null &&
          "outcome" in entry.result &&
          typeof entry.result.outcome === "object" &&
          entry.result.outcome !== null &&
          "optionId" in entry.result.outcome,
      );
      assert.equal(permissionResults.length, 2);
      assert.isTrue(
        permissionResults.every(
          (entry) =>
            typeof entry.result === "object" &&
            entry.result !== null &&
            "outcome" in entry.result &&
            typeof entry.result.outcome === "object" &&
            entry.result.outcome !== null &&
            "optionId" in entry.result.outcome &&
            entry.result.outcome.optionId === "allow-once",
        ),
      );

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("asks before a different command after Always allow this session", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-session-approval-scope");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EMIT_TOOL_CALLS: "1",
          T3_ACP_OMIT_ALLOW_ALWAYS: "1",
          T3_ACP_PERMISSION_REQUEST_COUNT: "2",
          T3_ACP_PERMISSION_TITLE: "Terminal",
          T3_ACP_SECOND_PERMISSION_COMMAND: "rm server/package.json",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const openedCount = yield* Ref.make(0);
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "request.opened"
          ? Effect.gen(function* () {
              const count = yield* Ref.updateAndGet(openedCount, (value) => value + 1);
              yield* adapter.respondToRequest(
                threadId,
                ApprovalRequestId.make(String(event.requestId)),
                count === 1 ? "acceptForSession" : "decline",
              );
            })
          : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({ threadId, input: "check approval scope", attachments: [] });
      assert.equal(yield* Ref.get(openedCount), 2);
      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("captures a plan under the provider instance GROK_HOME", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-instance-plan-home");
      const grokHome = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-instance-home-")),
      );
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EMIT_XAI_PLAN_MD_WRITE: "1",
          T3_ACP_PLAN_ROOT: grokHome,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath, {
        environment: { ...process.env, GROK_HOME: grokHome },
      });
      const plans = yield* Ref.make<ReadonlyArray<string>>([]);
      const completed = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (event.type === "turn.proposed.completed") {
          return Ref.update(plans, (current) => [...current, event.payload.planMarkdown]);
        }
        return event.type === "turn.completed"
          ? Deferred.succeed(completed, undefined).pipe(Effect.asVoid)
          : Effect.void;
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "write the plan", attachments: [] });
      yield* Deferred.await(completed);
      assert.deepEqual(yield* Ref.get(plans), [
        "# Mock plan\n\n- Write the feature\n- Add a test\n- Ship it",
      ]);
      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("handles xAI ask_user_question extension requests", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-xai-ask-user-question");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({ T3_ACP_EMIT_XAI_ASK_USER_QUESTION: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const requested =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.requested" }>>();
      const resolved =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.resolved" }>>();

      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (String(event.threadId) !== String(threadId)) {
          return Effect.void;
        }
        if (event.type === "user-input.requested") {
          return Deferred.succeed(requested, event).pipe(Effect.ignore);
        }
        if (event.type === "user-input.resolved") {
          return Deferred.succeed(resolved, event).pipe(Effect.ignore);
        }
        return Effect.void;
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "ask before continuing", attachments: [] })
        .pipe(Effect.forkChild);

      const requestedEvent = yield* Deferred.await(requested);
      assert.equal(requestedEvent.payload.questions.length, 1);
      assert.equal(requestedEvent.payload.questions[0]?.id, "Which scope should Grok use?");
      assert.equal(requestedEvent.payload.questions[0]?.question, "Which scope should Grok use?");
      assert.equal(requestedEvent.raw?.method, "_x.ai/ask_user_question");

      yield* adapter.respondToUserInput(
        threadId,
        ApprovalRequestId.make(String(requestedEvent.requestId)),
        {
          "Which scope should Grok use?": "Workspace",
        },
      );

      const resolvedEvent = yield* Deferred.await(resolved);
      assert.deepEqual(resolvedEvent.payload.answers, {
        "Which scope should Grok use?": "Workspace",
      });
      assert.equal(String(resolvedEvent.turnId), String(requestedEvent.turnId));
      yield* Fiber.join(sendTurnFiber);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("settles a stalled Grok turn after its first activity is user input", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-xai-ask-user-question");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({ T3_ACP_EMIT_XAI_ASK_USER_QUESTION_THEN_HANG: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath, {
        turnInactivityTimeoutMs: 1_000,
      });
      const requested =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.requested" }>>();
      const resolved =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.resolved" }>>();
      const completed =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>>();

      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (String(event.threadId) !== String(threadId)) {
          return Effect.void;
        }
        if (event.type === "user-input.requested") {
          return Deferred.succeed(requested, event).pipe(Effect.ignore);
        }
        if (event.type === "user-input.resolved") {
          return Deferred.succeed(resolved, event).pipe(Effect.ignore);
        }
        if (event.type === "turn.completed") {
          return Deferred.succeed(completed, event).pipe(Effect.ignore);
        }
        return Effect.void;
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "ask before continuing", attachments: [] })
        .pipe(Effect.forkChild);

      const requestedEvent = yield* Deferred.await(requested);
      assert.equal(requestedEvent.payload.questions.length, 1);
      assert.equal(requestedEvent.payload.questions[0]?.id, "Which scope should Grok use?");
      assert.equal(requestedEvent.payload.questions[0]?.question, "Which scope should Grok use?");
      assert.equal(requestedEvent.raw?.method, "_x.ai/ask_user_question");

      yield* adapter.respondToUserInput(
        threadId,
        ApprovalRequestId.make(String(requestedEvent.requestId)),
        {
          "Which scope should Grok use?": "Workspace",
        },
      );

      const resolvedEvent = yield* Deferred.await(resolved);
      assert.deepEqual(resolvedEvent.payload.answers, {
        "Which scope should Grok use?": "Workspace",
      });
      assert.equal(String(resolvedEvent.turnId), String(requestedEvent.turnId));

      yield* TestClock.adjust("1 second");
      const completedEvent = yield* Deferred.await(completed).pipe(
        Effect.timeout("2 seconds"),
        TestClock.withLive,
      );
      assert.equal(completedEvent.payload.state, "failed");
      yield* Fiber.join(sendTurnFiber);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("continues streaming events when native notification logging fails", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-native-log-failure");
      const wrapperPath = yield* Effect.promise(() => makeMockGrokWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath, {
        nativeEventLogger: {
          filePath: "memory://grok-native-events",
          write: (record: unknown) =>
            typeof record === "object" &&
            record !== null &&
            "event" in record &&
            typeof record.event === "object" &&
            record.event !== null &&
            "kind" in record.event &&
            record.event.kind === "notification"
              ? Effect.die(new Error("native log write failed"))
              : Effect.void,
          close: () => Effect.void,
        },
      });
      const contentDelta = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "content.delta" ? Deferred.succeed(contentDelta, undefined) : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "keep streaming", attachments: [] });
      yield* Deferred.await(contentDelta);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  // Production calls startSession from a request fiber that finishes as soon as
  // the session exists. `Effect.forkChild` made the notification consumer a
  // child of that fiber, and Effect interrupts a fiber's children when it
  // completes, so the consumer died on return and every later session/update
  // was dropped: the thread sat on "Working" forever while the provider
  // streamed its whole turn. Every other test here calls startSession directly
  // from the test fiber, which never completes, so the consumer survived and
  // the bug stayed invisible. Running it in a fiber that finishes is what
  // reproduces production.
  it.effect("keeps consuming notifications after the startSession fiber completes", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-consumer-outlives-start-session");
      const wrapperPath = yield* Effect.promise(() => makeMockGrokWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed" && String(event.threadId) === String(threadId)
              ? Deferred.succeed(turnCompleted, undefined).pipe(Effect.asVoid)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      const startSessionFiber = yield* adapter
        .startSession({
          threadId,
          provider: ProviderDriverKind.make("grok"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        })
        .pipe(Effect.forkChild);
      yield* Fiber.join(startSessionFiber).pipe(Effect.timeout("10 seconds"));

      // Forked, and the assertion waits on the projected event rather than on
      // sendTurn: with the consumer dead the turn never settles, so awaiting it
      // directly would hang until the suite timeout instead of failing here.
      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "hello grok", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(turnCompleted).pipe(Effect.timeout("10 seconds"));
      yield* Fiber.join(sendTurnFiber).pipe(Effect.timeout("10 seconds"));

      const delta = runtimeEvents.find(
        (event) => event.type === "content.delta" && String(event.threadId) === String(threadId),
      );
      assert.isDefined(
        delta,
        "no content.delta was projected after the startSession fiber completed",
      );
      if (delta?.type === "content.delta") {
        assert.equal(delta.payload.delta, "hello from mock");
      }

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
      // Live clock so the timeouts above are real: under the default test clock
      // they wait on virtual time that never advances, and a regression would
      // hang until the suite timeout instead of failing here.
    }).pipe(TestClock.withLive),
  );
});
