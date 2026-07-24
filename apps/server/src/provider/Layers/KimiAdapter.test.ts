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
  KimiSettings,
  ProviderDriverKind,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { makeKimiAdapter } from "./KimiAdapter.ts";
const decodeKimiSettings = Schema.decodeSync(KimiSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const mockAgentCommand = process.execPath;

async function makeMockKimiWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kimi-acp-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-kimi.sh");
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

const kimiAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-kimi-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

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

const makeTestAdapter = (binaryPath: string, options?: Parameters<typeof makeKimiAdapter>[1]) =>
  makeKimiAdapter(decodeKimiSettings({ binaryPath }), options).pipe(Effect.orDie);

it.layer(kimiAdapterTestLayer)("KimiAdapterLive", (it) => {
  it.effect(
    "synthesizes a turn for out-of-prompt session updates and closes it after quiescence",
    () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("kimi-autonomous-turn-synthesis");
        const wrapperPath = yield* Effect.promise(() =>
          makeMockKimiWrapper({
            T3_ACP_EMIT_AUTONOMOUS_BURSTS: "1",
            T3_ACP_AUTONOMOUS_INITIAL_DELAY_MS: "150",
            T3_ACP_AUTONOMOUS_TEXT: "kimi autonomous",
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
          provider: ProviderDriverKind.make("kimi"),
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
      const threadId = ThreadId.make("kimi-autonomous-two-bursts");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKimiWrapper({
          T3_ACP_EMIT_AUTONOMOUS_BURSTS: "1",
          T3_ACP_AUTONOMOUS_INITIAL_DELAY_MS: "150",
          T3_ACP_AUTONOMOUS_BURST_COUNT: "2",
          T3_ACP_AUTONOMOUS_BURST_GAP_MS: "800",
          T3_ACP_AUTONOMOUS_TEXT: "kimi double",
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
        provider: ProviderDriverKind.make("kimi"),
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
      const threadId = ThreadId.make("kimi-autonomous-prompt-overlap");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKimiWrapper({
          T3_ACP_EMIT_AUTONOMOUS_BURSTS: "1",
          T3_ACP_AUTONOMOUS_INITIAL_DELAY_MS: "100",
          T3_ACP_AUTONOMOUS_CHUNK_COUNT: "10",
          T3_ACP_AUTONOMOUS_CHUNK_GAP_MS: "150",
          T3_ACP_AUTONOMOUS_TEXT: "kimi overlap",
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
        provider: ProviderDriverKind.make("kimi"),
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
      const threadId = ThreadId.make("kimi-autonomous-no-resurrection");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kimi-acp-no-resurrection-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKimiWrapper({
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
        provider: ProviderDriverKind.make("kimi"),
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
      const threadId = ThreadId.make("kimi-autonomous-replay-only");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKimiWrapper({
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
        provider: ProviderDriverKind.make("kimi"),
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

  it.effect(
    "routes AskUserQuestion permission bridges to structured user input in full-access",
    () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("kimi-ask-user-question-full-access");
        const tempDir = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kimi-acp-ask-question-")),
        );
        const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
        const wrapperPath = yield* Effect.promise(() =>
          makeMockKimiWrapper({
            T3_ACP_EMIT_KIMI_ASK_USER_QUESTION: "1",
            T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          }),
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
          provider: ProviderDriverKind.make("kimi"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });

        const sendTurnFiber = yield* adapter
          .sendTurn({ threadId, input: "ask before continuing", attachments: [] })
          .pipe(Effect.forkChild);

        const requestedEvent = yield* Deferred.await(requested).pipe(Effect.timeout("2 seconds"));
        assert.equal(requestedEvent.payload.questions.length, 1);
        assert.equal(requestedEvent.payload.questions[0]?.id, "q0");
        assert.equal(requestedEvent.payload.questions[0]?.question, "Which scope should Kimi use?");
        assert.deepEqual(
          requestedEvent.payload.questions[0]?.options.map((option) => option.label),
          ["Workspace", "Session"],
        );

        yield* adapter.respondToUserInput(
          threadId,
          ApprovalRequestId.make(String(requestedEvent.requestId)),
          { q0: "Session" },
        );

        const resolvedEvent = yield* Deferred.await(resolved).pipe(Effect.timeout("2 seconds"));
        assert.deepEqual(resolvedEvent.payload.answers, { q0: "Session" });
        yield* Fiber.join(sendTurnFiber).pipe(Effect.timeout("2 seconds"));

        // The selected answer must reach the agent as q0_opt_1 — full-access
        // auto-approve would have picked q0_opt_0 without ever asking.
        const requestLog = yield* waitForFileContent(requestLogPath, 80, '"q0_opt_1"');
        assert.isTrue(
          requestLog
            .split("\n")
            .some((line) => line.includes('"optionId":"q0_opt_1"') && line.includes('"result"')),
        );

        yield* Fiber.interrupt(eventsFiber);
        yield* adapter.stopSession(threadId);
      }).pipe(TestClock.withLive),
  );

  it.effect("settles a pending AskUserQuestion as skip when the turn is interrupted", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kimi-ask-user-question-interrupt");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kimi-acp-ask-question-cancel-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKimiWrapper({
          T3_ACP_EMIT_KIMI_ASK_USER_QUESTION: "1",
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const turnStarted = yield* Deferred.make<TurnId>();
      const requested =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.requested" }>>();
      const resolved =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.resolved" }>>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (String(event.threadId) !== String(threadId)) {
          return Effect.void;
        }
        if (event.type === "turn.started" && event.turnId !== undefined) {
          return Deferred.succeed(turnStarted, event.turnId).pipe(Effect.ignore);
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
        provider: ProviderDriverKind.make("kimi"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "ask before continuing", attachments: [] })
        .pipe(Effect.forkChild);

      yield* Deferred.await(requested).pipe(Effect.timeout("2 seconds"));
      const turnId = yield* Deferred.await(turnStarted).pipe(Effect.timeout("2 seconds"));
      yield* adapter.interruptTurn(threadId, turnId).pipe(Effect.timeout("2 seconds"));
      yield* Fiber.join(sendTurnFiber).pipe(Effect.timeout("2 seconds"));

      const resolvedEvent = yield* Deferred.await(resolved).pipe(Effect.timeout("2 seconds"));
      assert.deepEqual(resolvedEvent.payload.answers, {});

      // The cancelled question must reach the agent as the skip option.
      const requestLog = yield* waitForFileContent(requestLogPath, 80, '"q0_skip"');
      assert.isTrue(
        requestLog
          .split("\n")
          .some((line) => line.includes('"optionId":"q0_skip"') && line.includes('"result"')),
      );

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("maps Kimi Agent tool calls to task.* events instead of generic tool-call items", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kimi-subagent-task-events");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKimiWrapper({
          T3_ACP_EMIT_SUBAGENT_TOOL_CALL: "1",
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
        provider: ProviderDriverKind.make("kimi"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "delegate to a subagent", attachments: [] });

      const threadEvents = runtimeEvents.filter(
        (event) => String(event.threadId) === String(threadId),
      );
      const taskStarted = threadEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "task.started" }> =>
          event.type === "task.started" && String(event.payload.taskId) === "subagent-tool-call-1",
      );
      const taskProgress = threadEvents.filter(
        (event) =>
          event.type === "task.progress" && String(event.payload.taskId) === "subagent-tool-call-1",
      );
      const taskCompleted = threadEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "task.completed" }> =>
          event.type === "task.completed" &&
          String(event.payload.taskId) === "subagent-tool-call-1",
      );
      const genericItems = threadEvents.filter(
        (event) =>
          (event.type === "item.updated" || event.type === "item.completed") &&
          String(event.itemId) === "subagent-tool-call-1",
      );
      const regularItems = threadEvents.filter(
        (event) =>
          (event.type === "item.updated" || event.type === "item.completed") &&
          String(event.itemId) === "regular-tool-call-1",
      );

      assert.lengthOf(taskStarted, 1);
      assert.equal(taskStarted[0]?.payload.entityType, "subagent");
      assert.equal(taskStarted[0]?.payload.subagentType, "coder");
      assert.equal(taskStarted[0]?.payload.description, "investigate the bug");
      assert.equal(taskStarted[0]?.payload.taskType, "sub-agent");
      assert.equal(taskStarted[0]?.payload.toolUseId, "subagent-tool-call-1");
      assert.isAtLeast(taskProgress.length, 1);
      assert.lengthOf(taskCompleted, 1);
      assert.equal(taskCompleted[0]?.payload.status, "completed");
      assert.equal(taskCompleted[0]?.payload.summary, "sub-agent final report");
      // No duplicate generic dynamic_tool_call row for the sub-agent call.
      assert.deepEqual(genericItems, []);
      // Regular tool calls in the same turn still flow through unchanged.
      assert.isNotEmpty(regularItems);
      assert.isTrue(regularItems.every((event) => event.payload.itemType === "command_execution"));
      const startedIndex = threadEvents.findIndex((event) => event.type === "task.started");
      const completedIndex = threadEvents.findIndex((event) => event.type === "task.completed");
      assert.isAtLeast(startedIndex, 0);
      assert.isAbove(completedIndex, startedIndex);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("maps failed Kimi Agent tool calls to task.completed with status failed", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kimi-subagent-task-failed");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKimiWrapper({
          T3_ACP_EMIT_SUBAGENT_TOOL_CALL: "1",
          T3_ACP_SUBAGENT_TOOL_CALL_FAILS: "1",
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
        provider: ProviderDriverKind.make("kimi"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "delegate to a failing subagent",
        attachments: [],
      });

      const threadEvents = runtimeEvents.filter(
        (event) => String(event.threadId) === String(threadId),
      );
      const taskCompleted = threadEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "task.completed" }> =>
          event.type === "task.completed" &&
          String(event.payload.taskId) === "subagent-tool-call-1",
      );
      const genericItems = threadEvents.filter(
        (event) =>
          (event.type === "item.updated" || event.type === "item.completed") &&
          String(event.itemId) === "subagent-tool-call-1",
      );

      assert.lengthOf(taskCompleted, 1);
      assert.equal(taskCompleted[0]?.payload.status, "failed");
      assert.equal(taskCompleted[0]?.payload.summary, "sub-agent failed to finish");
      assert.deepEqual(genericItems, []);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("stops open Kimi sub-agent tasks when the turn is interrupted", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kimi-subagent-task-interrupt");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kimi-acp-subagent-interrupt-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKimiWrapper({
          T3_ACP_EMIT_SUBAGENT_THEN_HANG: "1",
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnStarted = yield* Deferred.make<TurnId>();
      const subagentTaskStarted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          if (event.type === "turn.started" && event.turnId !== undefined) {
            yield* Deferred.succeed(turnStarted, event.turnId).pipe(Effect.ignore);
          }
          if (event.type === "task.started") {
            yield* Deferred.succeed(subagentTaskStarted, undefined).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kimi"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "delegate then interrupt", attachments: [] })
        .pipe(Effect.forkChild);
      const turnId = yield* Deferred.await(turnStarted).pipe(Effect.timeout("2 seconds"));
      // Wait until the sub-agent task is actually open before interrupting.
      yield* Deferred.await(subagentTaskStarted).pipe(Effect.timeout("2 seconds"));
      yield* waitForFileContent(requestLogPath, 80, '"method":"session/prompt"');
      yield* adapter.interruptTurn(threadId, turnId).pipe(Effect.timeout("2 seconds"));
      yield* Fiber.join(sendTurnFiber).pipe(Effect.timeout("2 seconds"));

      const threadEvents = runtimeEvents.filter(
        (event) => String(event.threadId) === String(threadId),
      );
      const taskStarted = threadEvents.filter(
        (event) =>
          event.type === "task.started" && String(event.payload.taskId) === "subagent-tool-call-1",
      );
      const taskCompleted = threadEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "task.completed" }> =>
          event.type === "task.completed" &&
          String(event.payload.taskId) === "subagent-tool-call-1",
      );

      assert.lengthOf(taskStarted, 1);
      assert.lengthOf(taskCompleted, 1);
      assert.equal(taskCompleted[0]?.payload.status, "stopped");
      assert.equal(String(taskCompleted[0]?.turnId), String(turnId));

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );
});
