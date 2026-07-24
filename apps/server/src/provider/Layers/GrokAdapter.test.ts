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
import { grokPromptSettlementBelongsToContext, makeGrokAdapter } from "./GrokAdapter.ts";
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
        assert.equal(delta.payload.streamKind, "assistant_text");
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("keeps streaming when startSession is wrapped in Effect.timeout", () =>
    // Regression: ProviderCommandReactor wraps startSession in Effect.timeout,
    // whose racer fiber exits once startup succeeds. The ACP notification
    // consumer must survive that (forkIn the session scope, not forkChild),
    // or every session/update is dropped and turns wedge on the drain barrier.
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-timeout-wrapped-thread");
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

      yield* adapter
        .startSession({
          threadId,
          provider: ProviderDriverKind.make("grok"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        })
        .pipe(Effect.timeout("30 seconds"));

      // Bounded so a regressed (dead) drain fails the test promptly instead of
      // hanging: with the consumer gone, sendTurn wedges on the drain barrier.
      yield* adapter
        .sendTurn({
          threadId,
          input: "hello grok",
          attachments: [],
        })
        .pipe(Effect.timeout("10 seconds"));

      yield* Deferred.await(turnCompleted).pipe(Effect.timeout("10 seconds"));
      yield* Fiber.interrupt(runtimeEventsFiber);

      const types = runtimeEvents.map((event) => event.type);
      assert.includeMembers(types, ["content.delta", "turn.completed"] as const);

      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("streams agent_thought_chunk as reasoning_text content deltas", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-thought-chunk-thread");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EMIT_THOUGHT_CHUNKS: "1",
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
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-4.5" },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "think then answer",
        attachments: [],
      });

      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);

      const contentDeltas = runtimeEvents.filter((event) => event.type === "content.delta");
      const reasoningDeltas = contentDeltas.filter(
        (event) => event.type === "content.delta" && event.payload.streamKind === "reasoning_text",
      );
      const assistantDeltas = contentDeltas.filter(
        (event) => event.type === "content.delta" && event.payload.streamKind === "assistant_text",
      );

      assert.isAtLeast(reasoningDeltas.length, 2);
      assert.equal(
        reasoningDeltas
          .map((event) => (event.type === "content.delta" ? event.payload.delta : ""))
          .join(""),
        "thinking step by step then answering",
      );
      assert.isAtLeast(assistantDeltas.length, 1);
      assert.equal(
        assistantDeltas
          .map((event) => (event.type === "content.delta" ? event.payload.delta : ""))
          .join(""),
        "hello from mock",
      );

      // Assistant item lifecycle still opens for message text; reasoning does not
      // require its own item.started/item.completed (Codex stream parity).
      const assistantItems = runtimeEvents.filter(
        (event) =>
          (event.type === "item.started" || event.type === "item.completed") &&
          event.payload.itemType === "assistant_message",
      );
      assert.isAtLeast(assistantItems.length, 1);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("keeps stderr out of the session.exited reason", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-process-exit-reason");
      const stderrTail = "fatal: grok mock crashed";
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EXIT_ON_PROMPT: "1",
          T3_ACP_EXIT_STDERR: stderrTail,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      const runtimeErrorReceived = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => runtimeEvents.push(event)).pipe(
          Effect.andThen(
            event.type === "runtime.error"
              ? Deferred.succeed(runtimeErrorReceived, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-4.5" },
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "crash now", attachments: [] })
        .pipe(Effect.ignore, Effect.forkChild);
      yield* Deferred.await(runtimeErrorReceived);

      const exited = runtimeEvents.find((event) => event.type === "session.exited");
      assert.isDefined(exited);
      if (exited?.type === "session.exited") {
        assert.equal(exited.payload.reason, "Grok ACP process exited with code 7.");
        assert.equal(exited.payload.stderrTail, stderrTail);
      }

      const runtimeError = runtimeEvents.find((event) => event.type === "runtime.error");
      assert.isDefined(runtimeError);
      if (runtimeError?.type === "runtime.error") {
        assert.equal(
          runtimeError.payload.message,
          `Grok ACP process exited with code 7.\nLast stderr:\n${stderrTail}`,
        );
      }

      yield* adapter.stopSession(threadId).pipe(Effect.ignore);
      yield* Fiber.interrupt(sendTurnFiber);
      yield* Fiber.interrupt(runtimeEventsFiber);
    }),
  );

  it.effect("retires a crashed session and settles its pending approval", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-crash-pending-approval");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-acp-crash-")),
      );
      const pidPath = NodePath.join(tempDir, "pid");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EMIT_TOOL_CALLS: "1",
          T3_ACP_PID_PATH: pidPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      const approvalRequested = yield* Deferred.make<void>();
      const sessionExited = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => runtimeEvents.push(event)).pipe(
          Effect.andThen(
            event.type === "request.opened"
              ? Deferred.succeed(approvalRequested, undefined)
              : event.type === "session.exited"
                ? Deferred.succeed(sessionExited, undefined)
                : Effect.void,
          ),
          Effect.ignore,
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-4.5" },
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "crash during approval", attachments: [] })
        .pipe(Effect.ignore, Effect.forkChild);
      yield* Deferred.await(approvalRequested);
      const pid = Number(yield* Effect.promise(() => NodeFSP.readFile(pidPath, "utf8")));
      process.kill(pid, "SIGUSR2");

      yield* Deferred.await(sessionExited);
      yield* Fiber.await(sendTurnFiber);
      yield* adapter.stopSession(threadId).pipe(Effect.ignore);

      assert.equal(runtimeEvents.filter((event) => event.type === "session.exited").length, 1);
      assert.isFalse(
        (yield* adapter.listSessions()).some((session) => session.threadId === threadId),
      );
      assert.equal(yield* adapter.hasSession(threadId), false);

      yield* Fiber.interrupt(runtimeEventsFiber);
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
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-4.5" },
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
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-4.5" },
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
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-4.5" },
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
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-4.5" },
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
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-4.5" },
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
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-4.5" },
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
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-4.5" },
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
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-4.5" },
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
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-4.5" },
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
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-4.5" },
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
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-4.5" },
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
          provider: ProviderDriverKind.make("codex"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-4.5" },
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
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-4.5" },
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

  it.effect(
    "synthesizes a turn for out-of-prompt session updates and closes it after quiescence",
    () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("grok-autonomous-turn-synthesis");
        const wrapperPath = yield* Effect.promise(() =>
          makeMockGrokWrapper({
            T3_ACP_EMIT_AUTONOMOUS_BURSTS: "1",
            T3_ACP_AUTONOMOUS_INITIAL_DELAY_MS: "150",
            T3_ACP_AUTONOMOUS_TEXT: "grok autonomous",
          }),
        );
        const adapter = yield* makeTestAdapter(wrapperPath);

        const runtimeEvents: ProviderRuntimeEvent[] = [];
        const turnStarted = yield* Deferred.make<TurnId>();
        const burstFinished = yield* Deferred.make<void>();
        const turnCompleted =
          yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>>();
        const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.gen(function* () {
            runtimeEvents.push(event);
            if (String(event.threadId) !== String(threadId)) {
              return;
            }
            if (event.type === "turn.started" && event.turnId !== undefined) {
              yield* Deferred.succeed(turnStarted, event.turnId).pipe(Effect.ignore);
            }
            if (event.type === "content.delta" && event.payload.delta.endsWith("chunk 3")) {
              yield* Deferred.succeed(burstFinished, undefined).pipe(Effect.ignore);
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

        const synthesizedTurnId = yield* Deferred.await(turnStarted);
        yield* Deferred.await(burstFinished);

        const runningSessions = yield* adapter.listSessions();
        const runningSession = runningSessions.find((session) => session.threadId === threadId);
        assert.equal(runningSession?.status, "running");
        assert.equal(String(runningSession?.activeTurnId), String(synthesizedTurnId));

        // No prompt RPC settles a synthesized turn: it closes once the event
        // stream has been quiet for the idle window.
        yield* TestClock.adjust("3 seconds");
        const completedEvent = yield* Deferred.await(turnCompleted);

        const threadEvents = runtimeEvents.filter(
          (event) => String(event.threadId) === String(threadId),
        );
        const turnStartedEvents = threadEvents.filter((event) => event.type === "turn.started");
        const turnCompletedEvents = threadEvents.filter((event) => event.type === "turn.completed");
        const deltas = threadEvents.filter(
          (event): event is Extract<ProviderRuntimeEvent, { type: "content.delta" }> =>
            event.type === "content.delta",
        );
        const readySessions = yield* adapter.listSessions();
        const readySession = readySessions.find((session) => session.threadId === threadId);

        assert.lengthOf(turnStartedEvents, 1);
        assert.lengthOf(turnCompletedEvents, 1);
        assert.isAtLeast(deltas.length, 3);
        assert.isTrue(deltas.every((event) => String(event.turnId) === String(synthesizedTurnId)));
        assert.equal(String(completedEvent.turnId), String(synthesizedTurnId));
        assert.equal(completedEvent.payload.state, "completed");
        assert.equal(completedEvent.payload.stopReason, "end_turn");
        assert.equal(readySession?.status, "ready");
        assert.isUndefined(readySession?.activeTurnId);

        yield* Fiber.interrupt(runtimeEventsFiber);
        yield* adapter.stopSession(threadId);
      }),
  );

  it.effect("synthesizes distinct turns for autonomous bursts separated by a quiet gap", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-autonomous-two-bursts");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EMIT_AUTONOMOUS_BURSTS: "1",
          T3_ACP_AUTONOMOUS_INITIAL_DELAY_MS: "150",
          T3_ACP_AUTONOMOUS_BURST_COUNT: "2",
          T3_ACP_AUTONOMOUS_BURST_GAP_MS: "800",
          T3_ACP_AUTONOMOUS_TEXT: "grok double",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const startedTurnIds: TurnId[] = [];
      const firstBurstFinished = yield* Deferred.make<void>();
      const secondBurstFinished = yield* Deferred.make<void>();
      const completedCountRef = yield* Ref.make(0);
      const firstTurnCompleted = yield* Deferred.make<TurnId>();
      const secondTurnCompleted = yield* Deferred.make<TurnId>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          if (event.type === "turn.started" && event.turnId !== undefined) {
            startedTurnIds.push(event.turnId);
          }
          if (event.type === "content.delta" && event.payload.delta.endsWith("burst 1 chunk 3")) {
            yield* Deferred.succeed(firstBurstFinished, undefined).pipe(Effect.ignore);
          }
          if (event.type === "content.delta" && event.payload.delta.endsWith("burst 2 chunk 3")) {
            yield* Deferred.succeed(secondBurstFinished, undefined).pipe(Effect.ignore);
          }
          if (event.type === "turn.completed" && event.turnId !== undefined) {
            const count = yield* Ref.updateAndGet(completedCountRef, (current) => current + 1);
            if (count === 1) {
              yield* Deferred.succeed(firstTurnCompleted, event.turnId).pipe(Effect.ignore);
            }
            if (count === 2) {
              yield* Deferred.succeed(secondTurnCompleted, event.turnId).pipe(Effect.ignore);
            }
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      yield* Deferred.await(firstBurstFinished);
      // Close the first synthesized turn before the second burst arrives.
      yield* TestClock.adjust("3 seconds");
      const firstCompletedTurnId = yield* Deferred.await(firstTurnCompleted);

      yield* Deferred.await(secondBurstFinished);
      yield* TestClock.adjust("3 seconds");
      const secondCompletedTurnId = yield* Deferred.await(secondTurnCompleted);

      const threadEvents = runtimeEvents.filter(
        (event) => String(event.threadId) === String(threadId),
      );
      const indexOf = (predicate: (event: ProviderRuntimeEvent) => boolean) =>
        threadEvents.findIndex(predicate);
      const firstStartedIndex = indexOf(
        (event) =>
          event.type === "turn.started" && String(event.turnId) === String(startedTurnIds[0]),
      );
      const firstCompletedIndex = indexOf(
        (event) =>
          event.type === "turn.completed" && String(event.turnId) === String(startedTurnIds[0]),
      );
      const secondStartedIndex = indexOf(
        (event) =>
          event.type === "turn.started" && String(event.turnId) === String(startedTurnIds[1]),
      );
      const secondCompletedIndex = indexOf(
        (event) =>
          event.type === "turn.completed" && String(event.turnId) === String(startedTurnIds[1]),
      );
      const firstBurstDeltas = threadEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "content.delta" }> =>
          event.type === "content.delta" && event.payload.delta.includes("burst 1"),
      );

      assert.lengthOf(startedTurnIds, 2);
      assert.notEqual(String(startedTurnIds[0]), String(startedTurnIds[1]));
      assert.equal(String(firstCompletedTurnId), String(startedTurnIds[0]));
      assert.equal(String(secondCompletedTurnId), String(startedTurnIds[1]));
      assert.isAtLeast(firstStartedIndex, 0);
      assert.isAbove(firstCompletedIndex, firstStartedIndex);
      assert.isAbove(secondStartedIndex, firstCompletedIndex);
      assert.isAbove(secondCompletedIndex, secondStartedIndex);
      assert.isTrue(
        firstBurstDeltas.every((event) => String(event.turnId) === String(startedTurnIds[0])),
      );

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("closes a synthesized turn when a prompt arrives mid-burst", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-autonomous-prompt-overlap");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EMIT_AUTONOMOUS_BURSTS: "1",
          T3_ACP_AUTONOMOUS_INITIAL_DELAY_MS: "100",
          T3_ACP_AUTONOMOUS_CHUNK_COUNT: "10",
          T3_ACP_AUTONOMOUS_CHUNK_GAP_MS: "150",
          T3_ACP_AUTONOMOUS_TEXT: "grok overlap",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const synthesizedTurnStarted = yield* Deferred.make<TurnId>();
      const synthesizedTurnCompleted = yield* Deferred.make<TurnId>();
      const promptTurnCompleted = yield* Deferred.make<TurnId>();
      const completedCountRef = yield* Ref.make(0);
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          if (event.type === "turn.started" && event.turnId !== undefined) {
            yield* Deferred.succeed(synthesizedTurnStarted, event.turnId).pipe(Effect.ignore);
          }
          if (event.type !== "turn.completed" || event.turnId === undefined) {
            return;
          }
          // The synthesized turn always closes (in sendTurn prep) before the
          // prompt turn completes, so completion order is deterministic.
          const count = yield* Ref.updateAndGet(completedCountRef, (current) => current + 1);
          if (count === 1) {
            yield* Deferred.succeed(synthesizedTurnCompleted, event.turnId).pipe(Effect.ignore);
          }
          if (count === 2) {
            yield* Deferred.succeed(promptTurnCompleted, event.turnId).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const synthesizedTurnId = yield* Deferred.await(synthesizedTurnStarted);
      // The burst is still streaming: the prompt must close the synthesized
      // turn first, then run as its own turn.
      const sendTurnResult = yield* adapter.sendTurn({
        threadId,
        input: "user prompt during autonomous work",
        attachments: [],
      });
      const completedSynthesizedTurnId = yield* Deferred.await(synthesizedTurnCompleted);
      const completedPromptTurnId = yield* Deferred.await(promptTurnCompleted);

      const threadEvents = runtimeEvents.filter(
        (event) => String(event.threadId) === String(threadId),
      );
      const turnStartedEvents = threadEvents.filter((event) => event.type === "turn.started");
      const synthesizedCompletedIndex = threadEvents.findIndex(
        (event) =>
          event.type === "turn.completed" && String(event.turnId) === String(synthesizedTurnId),
      );
      const promptStartedIndex = threadEvents.findIndex(
        (event) =>
          event.type === "turn.started" && String(event.turnId) === String(sendTurnResult.turnId),
      );
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);

      assert.equal(String(completedSynthesizedTurnId), String(synthesizedTurnId));
      assert.notEqual(String(sendTurnResult.turnId), String(synthesizedTurnId));
      assert.equal(String(completedPromptTurnId), String(sendTurnResult.turnId));
      assert.lengthOf(turnStartedEvents, 2);
      assert.isAtLeast(synthesizedCompletedIndex, 0);
      assert.isAbove(promptStartedIndex, synthesizedCompletedIndex);
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("does not synthesize a turn for cancel-tail events after an interrupt", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-autonomous-no-resurrection");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-acp-no-resurrection-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_HANG_PROMPT_FOREVER: "1",
          T3_ACP_EMIT_LATE_UPDATE_AFTER_CANCEL: "1",
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

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
        .sendTurn({ threadId, input: "cancel then flush late events", attachments: [] })
        .pipe(Effect.forkChild);
      const turnId = yield* Deferred.await(turnStarted).pipe(Effect.timeout("2 seconds"));
      // Wait until the prompt reached the mock so its cancel releases the hung
      // prompt immediately instead of racing ahead of it.
      yield* waitForFileContent(requestLogPath, 80, '"method":"session/prompt"');
      yield* adapter.interruptTurn(threadId, turnId).pipe(Effect.timeout("2 seconds"));
      yield* Fiber.join(sendTurnFiber).pipe(Effect.timeout("2 seconds"));
      // The mock flushes a late session/update ~50ms after the cancel; give it
      // time to arrive and be processed (and dropped).
      yield* Effect.sleep("500 millis");

      const threadEvents = runtimeEvents.filter(
        (event) => String(event.threadId) === String(threadId),
      );
      const turnStartedEvents = threadEvents.filter((event) => event.type === "turn.started");
      const turnCompletedEvents = threadEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed",
      );
      const deltas = threadEvents.filter((event) => event.type === "content.delta");

      assert.lengthOf(turnStartedEvents, 1);
      assert.lengthOf(turnCompletedEvents, 1);
      assert.equal(turnCompletedEvents[0]?.payload.state, "cancelled");
      assert.deepEqual(deltas, []);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("does not synthesize a turn for replay or mode-update notifications", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-autonomous-replay-only");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EMIT_AUTONOMOUS_REPLAY_ONLY: "1",
          T3_ACP_AUTONOMOUS_INITIAL_DELAY_MS: "150",
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
      });

      // The replay-flagged chunk and mode update arrive ~150ms after start.
      yield* Effect.sleep("600 millis");

      const threadEvents = runtimeEvents.filter(
        (event) => String(event.threadId) === String(threadId),
      );
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);

      assert.isFalse(threadEvents.some((event) => event.type === "turn.started"));
      assert.isFalse(threadEvents.some((event) => event.type === "turn.completed"));
      assert.isFalse(threadEvents.some((event) => event.type === "content.delta"));
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );
});
