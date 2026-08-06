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
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  ApprovalRequestId,
  PiAgentSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderSession,
  type ProviderSessionStartInput,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import {
  isPiThinkingLevel,
  makePiAgentAdapter,
  resolvePiModelSelection,
} from "./PiAgentAdapter.ts";
import { makePiRecordSplitter, parsePiResumeCursor } from "./PiAgentSessionRuntime.ts";
const decodePiAgentSettings = Schema.decodeSync(PiAgentSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/pi-mock-agent.ts");
const mockAgentCommand = process.execPath;

async function makeMockPiWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-pi.sh");
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

const piAgentAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-pi-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (binaryPath: string, options?: Parameters<typeof makePiAgentAdapter>[1]) =>
  makePiAgentAdapter(decodePiAgentSettings({ binaryPath }), options).pipe(Effect.orDie);

const startMockSession = (
  adapter: {
    startSession: (
      input: ProviderSessionStartInput,
    ) => Effect.Effect<ProviderSession, unknown, never>;
  },
  threadId: ThreadId,
  extraEnv?: Record<string, string>,
  resumeCursor?: unknown,
) =>
  Effect.gen(function* () {
    const wrapperPath = yield* Effect.promise(() => makeMockPiWrapper(extraEnv));
    return yield* adapter.startSession({
      threadId,
      provider: ProviderDriverKind.make("piAgent"),
      cwd: process.cwd(),
      runtimeMode: "full-access",
      modelSelection: {
        instanceId: ProviderInstanceId.make("piAgent"),
        model: "anthropic/claude-sonnet-4-6",
      },
      ...(resumeCursor !== undefined ? { resumeCursor } : {}),
    });
  });

it("splits pi JSONL records on newlines only and strips a trailing CR", () => {
  const splitter = makePiRecordSplitter();
  // A record without a trailing newline is held until the next chunk.
  const records = splitter.push(
    Buffer.from('{"type":"get_state"}\r\n{"type":"response","command":"get_state"', "utf8"),
  );
  assert.deepEqual(records, ['{"type":"get_state"}']);
  assert.deepEqual(
    splitter.push(Buffer.from('}\n{"message":"line\\u2028sep\\u2029ok"}\n', "utf8")),
    ['{"type":"response","command":"get_state"}', '{"message":"line\\u2028sep\\u2029ok"}'],
  );
  assert.deepEqual(splitter.flush(), []);
});

it("parses the versioned resume cursor and ignores mismatches", () => {
  assert.deepEqual(parsePiResumeCursor({ schemaVersion: 1, sessionId: "s1" }), {
    sessionId: "s1",
  });
  assert.isUndefined(parsePiResumeCursor({ schemaVersion: 2, sessionId: "s1" }));
  assert.isUndefined(parsePiResumeCursor({ schemaVersion: 1 }));
  assert.isUndefined(parsePiResumeCursor(undefined));
});

it("resolves pi model slugs against the catalog", () => {
  const catalog = [
    { id: "claude-sonnet-4-6", name: undefined, provider: "anthropic", api: undefined },
  ];
  assert.deepEqual(resolvePiModelSelection("anthropic/claude-sonnet-4-6", catalog), {
    provider: "anthropic",
    modelId: "claude-sonnet-4-6",
  });
  assert.deepEqual(resolvePiModelSelection("claude-sonnet-4-6", catalog), {
    provider: "anthropic",
    modelId: "claude-sonnet-4-6",
  });
  assert.deepEqual(resolvePiModelSelection("unknown-bare-id", catalog), {
    provider: "anthropic",
    modelId: "unknown-bare-id",
  });
});

it("recognizes pi thinking levels", () => {
  assert.isTrue(isPiThinkingLevel("medium"));
  assert.isTrue(isPiThinkingLevel("xhigh"));
  assert.isFalse(isPiThinkingLevel("ultra"));
});

it.layer(piAgentAdapterTestLayer)("PiAgentAdapter", (it) => {
  it.effect("starts a session and maps a mock pi prompt flow to runtime events", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-mock-thread");
      const wrapperPath = yield* Effect.promise(() => makeMockPiWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed" && String(event.threadId) === String(threadId)
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      const session = yield* startMockSession(adapter, threadId);

      assert.equal(session.provider, "piAgent");
      assert.deepEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-pi-session-1",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "hello pi",
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
        "content.delta",
        "turn.completed",
      ] as const);

      const delta = runtimeEvents.find((e) => e.type === "content.delta");
      assert.isDefined(delta);
      if (delta?.type === "content.delta") {
        assert.equal(delta.payload.delta, "hello from mock pi");
      }

      const tokenUsage = runtimeEvents.find((e) => e.type === "thread.token-usage.updated");
      assert.isDefined(tokenUsage);
      if (tokenUsage?.type === "thread.token-usage.updated") {
        assert.equal(tokenUsage.payload.usage.usedTokens, 150);
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("emits reasoning deltas and tool item lifecycles from pi events", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-tool-thread");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockPiWrapper({
          T3_PI_EMIT_TOOL_CALLS: "1",
          T3_PI_EMIT_THINKING: "1",
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
            event.type === "turn.completed" && String(event.threadId) === String(threadId)
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* startMockSession(adapter, threadId);
      yield* adapter.sendTurn({ threadId, input: "use tools", attachments: [] });
      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);

      const reasoning = runtimeEvents.find(
        (e): e is Extract<ProviderRuntimeEvent, { type: "content.delta" }> =>
          e.type === "content.delta" && e.payload.streamKind === "reasoning_text",
      );
      assert.isDefined(reasoning);
      assert.equal(reasoning?.payload.delta, "mock thinking");

      const startedItem = runtimeEvents.find(
        (e): e is Extract<ProviderRuntimeEvent, { type: "item.started" }> =>
          e.type === "item.started",
      );
      assert.isDefined(startedItem);
      assert.equal(startedItem?.payload.itemType, "command_execution");
      assert.equal(startedItem?.payload.title, "Ran command");

      const completedItem = runtimeEvents.find(
        (e): e is Extract<ProviderRuntimeEvent, { type: "item.completed" }> =>
          e.type === "item.completed" && e.payload.itemType === "command_execution",
      );
      assert.isDefined(completedItem);
      assert.equal(completedItem?.payload.status, "completed");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("completes an aborted turn as interrupted", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-interrupt-thread");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockPiWrapper({ T3_PI_HANG_PROMPT_FOREVER: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed" && String(event.threadId) === String(threadId)
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* startMockSession(adapter, threadId);
      const sendTurnResult = yield* adapter.sendTurn({
        threadId,
        input: "hang forever",
        attachments: [],
      });
      yield* adapter.interruptTurn(threadId, sendTurnResult.turnId);
      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);

      const completedEvent = runtimeEvents.find(
        (e): e is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          e.type === "turn.completed" && String(e.threadId) === String(threadId),
      );
      assert.equal(completedEvent?.payload.state, "interrupted");

      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((s) => s.threadId === threadId);
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("fails the turn when pi rejects the prompt", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-prompt-failure");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockPiWrapper({ T3_PI_FAIL_PROMPT: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed" && String(event.threadId) === String(threadId)
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* startMockSession(adapter, threadId);
      const error = yield* Effect.flip(
        adapter.sendTurn({ threadId, input: "fail prompt", attachments: [] }),
      );
      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);

      assert.equal(error._tag, "ProviderAdapterRequestError");
      const completedEvent = runtimeEvents.find(
        (e): e is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          e.type === "turn.completed" && String(e.threadId) === String(threadId),
      );
      assert.equal(completedEvent?.payload.state, "failed");
      assert.isString(completedEvent?.payload.errorMessage);

      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((s) => s.threadId === threadId);
      assert.equal(readySession?.status, "ready");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("surfaces pi confirm requests as user input and answers them", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-confirm-thread");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockPiWrapper({ T3_PI_EMIT_CONFIRM: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const requested =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.requested" }>>();
      const turnCompleted = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          if (String(event.threadId) !== String(threadId)) return;
          if (event.type === "user-input.requested") {
            yield* Deferred.succeed(requested, event).pipe(Effect.ignore);
            return;
          }
          if (event.type === "turn.completed") {
            yield* Deferred.succeed(turnCompleted, undefined).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* startMockSession(adapter, threadId);
      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "confirm this", attachments: [] })
        .pipe(Effect.forkChild);

      const requestedEvent = yield* Deferred.await(requested);
      assert.equal(requestedEvent.payload.questions.length, 1);
      assert.deepEqual(
        requestedEvent.payload.questions[0]?.options.map((option) => option.label),
        ["Allow", "Deny"],
      );

      yield* adapter.respondToUserInput(
        threadId,
        ApprovalRequestId.make(String(requestedEvent.requestId)),
        { [requestedEvent.payload.questions[0]?.id ?? "answer"]: "Allow" },
      );

      yield* Deferred.await(turnCompleted);
      yield* Fiber.join(sendTurnFiber);
      yield* Fiber.interrupt(eventsFiber);

      const completedEvent = yield* adapter
        .listSessions()
        .pipe(Effect.map((sessions) => sessions.find((s) => s.threadId === threadId)));
      assert.equal(completedEvent?.status, "ready");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("auto-cancels pi free-text input requests with a warning", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-input-thread");
      const wrapperPath = yield* Effect.promise(() => makeMockPiWrapper({ T3_PI_EMIT_INPUT: "1" }));
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed" && String(event.threadId) === String(threadId)
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* startMockSession(adapter, threadId);
      yield* adapter.sendTurn({ threadId, input: "type something", attachments: [] });
      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);

      const warning = runtimeEvents.find(
        (e): e is Extract<ProviderRuntimeEvent, { type: "runtime.warning" }> =>
          e.type === "runtime.warning" && e.payload.message.includes("free-text"),
      );
      assert.isDefined(warning);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("surfaces pi notify extension requests as warnings", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-notify-thread");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockPiWrapper({ T3_PI_EMIT_NOTIFY: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const warning =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "runtime.warning" }>>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "runtime.warning" && String(event.threadId) === String(threadId)
          ? Deferred.succeed(warning, event).pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkChild);

      yield* startMockSession(adapter, threadId);
      yield* adapter.sendTurn({ threadId, input: "notify me", attachments: [] });
      const warningEvent = yield* Deferred.await(warning);
      assert.equal(warningEvent.payload.message, "A notification");

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("rejects rollback with a validation error", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-rollback-thread");
      const wrapperPath = yield* Effect.promise(() => makeMockPiWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);
      yield* startMockSession(adapter, threadId);

      const error = yield* Effect.flip(adapter.rollbackThread(threadId, 1));
      assert.equal(error._tag, "ProviderAdapterValidationError");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("rejects approval responses because pi has no permission system", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-approval-thread");
      const wrapperPath = yield* Effect.promise(() => makeMockPiWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);
      yield* startMockSession(adapter, threadId);

      const error = yield* Effect.flip(
        adapter.respondToRequest(threadId, ApprovalRequestId.make("req-1"), "accept"),
      );
      assert.equal(error._tag, "ProviderAdapterValidationError");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("reads the pi thread back from get_messages", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-read-thread");
      const wrapperPath = yield* Effect.promise(() => makeMockPiWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);
      yield* startMockSession(adapter, threadId);

      const snapshot = yield* adapter.readThread(threadId);
      assert.equal(snapshot.turns.length, 1);
      assert.equal(snapshot.turns[0]?.items.length, 2);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("resumes a session from a versioned resume cursor", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-resume-thread");
      const wrapperPath = yield* Effect.promise(() => makeMockPiWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      const sessionStarted =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "session.started" }>>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "session.started" && String(event.threadId) === String(threadId)
          ? Deferred.succeed(sessionStarted, event).pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkChild);

      const session = yield* startMockSession(adapter, threadId, undefined, {
        schemaVersion: 1,
        sessionId: "mock-pi-session-1",
      });
      const startedEvent = yield* Deferred.await(sessionStarted);

      assert.deepEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-pi-session-1",
      });
      assert.equal(startedEvent.payload.resume, true);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("steers into the active turn when a second prompt arrives mid-run", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-steer-thread");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockPiWrapper({ T3_PI_DELAY_SETTLE_MS: "400" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const contentDelta = yield* Deferred.make<void>();
      const turnCompleted = yield* Deferred.make<void>();
      const turnCompletedCount = yield* Deferred.make<number>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          if (String(event.threadId) !== String(threadId)) return;
          if (event.type === "content.delta") {
            yield* Deferred.succeed(contentDelta, undefined).pipe(Effect.ignore);
            return;
          }
          if (event.type === "turn.completed") {
            yield* Deferred.succeed(turnCompleted, undefined).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* startMockSession(adapter, threadId);
      const firstSendFiber = yield* adapter
        .sendTurn({ threadId, input: "first prompt", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(contentDelta);

      const steerResult = yield* adapter.sendTurn({
        threadId,
        input: "steer prompt",
        attachments: [],
      });
      const firstResult = yield* Fiber.join(firstSendFiber);
      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(eventsFiber);

      assert.equal(String(steerResult.turnId), String(firstResult.turnId));

      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((s) => s.threadId === threadId);
      assert.equal(readySession?.status, "ready");
      void turnCompletedCount;

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("rejects sendTurn with empty input and no attachments", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-empty-turn");
      const wrapperPath = yield* Effect.promise(() => makeMockPiWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);
      yield* startMockSession(adapter, threadId);

      const error = yield* Effect.flip(
        adapter.sendTurn({ threadId, input: "   ", attachments: [] }),
      );
      assert.equal(error._tag, "ProviderAdapterValidationError");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("closes the pi child process when a session stops", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-stop-session-close");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-adapter-exit-log-")),
      );
      const exitLogPath = NodePath.join(tempDir, "exit.log");

      const wrapperPath = yield* Effect.promise(() =>
        makeMockPiWrapper({
          T3_PI_EXIT_LOG_PATH: exitLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* startMockSession(adapter, threadId);
      yield* adapter.stopSession(threadId);

      const exitLog = yield* waitForFileContent(exitLogPath);
      assert.include(exitLog, "SIGTERM");
    }),
  );

  it.effect("rejects startSession when provider mismatches", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() => makeMockPiWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);
      const threadId = ThreadId.make("pi-provider-mismatch");

      const error = yield* Effect.flip(
        adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("cursor"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        }),
      );

      assert.equal(error._tag, "ProviderAdapterValidationError");
    }),
  );

  it.effect("rejects startSession when cwd is missing", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() => makeMockPiWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);
      const threadId = ThreadId.make("pi-cwd-missing");

      const error = yield* Effect.flip(
        adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("piAgent"),
          cwd: "   ",
          runtimeMode: "full-access",
        }),
      );

      assert.equal(error._tag, "ProviderAdapterValidationError");
    }),
  );
});
