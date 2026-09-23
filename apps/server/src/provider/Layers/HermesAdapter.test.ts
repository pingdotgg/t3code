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
import * as TestClock from "effect/testing/TestClock";

import {
  ApprovalRequestId,
  HermesSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { ServerConfig } from "../../config.ts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";
import { resetHermesAcpAuthMethodIdCacheForTests } from "../acp/HermesAcpSupport.ts";
import { makeHermesAdapter, selectHermesPermissionOptionId } from "./HermesAdapter.ts";

const decodeHermesSettings = Schema.decodeSync(HermesSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
// Stopping a session kills the agent with SIGTERM; Windows terminates the
// process instead, so the mock never sees a signal to log.
const windowsHost = HostProcessPlatform.defaultValue() === "win32";

async function makeMockHermesWrapper(
  extraEnv?: Record<string, string>,
  options?: { readonly argvLogPath?: string },
) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-acp-mock-"));
  return writeFakeCli({
    directory: dir,
    name: "fake-hermes",
    env: extraEnv ?? {},
    source: execScriptSource({
      scriptPath: mockAgentPath,
      ...(options?.argvLogPath ? { argvLogPath: options.argvLogPath } : {}),
    }),
  });
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

/**
 * Real-wall-clock counterpart to {@link waitForFileContent}. `it.effect`
 * provides a virtual TestClock, under which `Effect.sleep` never elapses
 * without an explicit `TestClock.adjust` — so a retry loop built on it hangs
 * forever the moment its first attempt finds nothing. Use this instead when
 * polling for a condition that a forked, still-running fiber must reach on
 * its own schedule (not something already resolved by the time of the call).
 */
function waitForFileContentReal(
  filePath: string,
  attempts: number,
  expectedContent: string,
): Effect.Effect<string> {
  return Effect.promise(async () => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const raw = await NodeFSP.readFile(filePath, "utf8").catch(() => "");
      if (raw.includes(expectedContent)) {
        return raw;
      }
      await new Promise((resolve) => {
        // @effect-diagnostics-next-line globalTimers:off -- real wall-clock delay; this poll must not use Effect.sleep, which the virtual TestClock freezes.
        setTimeout(resolve, 25);
      });
    }
    throw new Error(`Timed out waiting for '${expectedContent}' at ${filePath}`);
  });
}

/**
 * Bounds `effect` by a real wall-clock deadline, immune to the virtual
 * TestClock `it.layer`/`it.effect` provide (`Effect.timeout` alone would
 * never fire there without an explicit `TestClock.adjust`, so a genuine hang
 * and a passing run would look identical).
 */
function withRealTimeout<A, E>(
  effect: Effect.Effect<A, E>,
  milliseconds: number,
): Effect.Effect<A, E> {
  const realTimeout = Effect.promise<never>(
    () =>
      new Promise((_resolve, reject) => {
        // @effect-diagnostics-next-line globalTimers:off -- real wall-clock deadline; Effect.sleep is frozen by the virtual TestClock here.
        setTimeout(
          () => reject(new Error(`Timed out after ${milliseconds}ms (real clock)`)),
          milliseconds,
        );
      }),
  ).pipe(Effect.orDie);
  return Effect.raceFirst(effect, realTimeout);
}

async function readJsonLines(filePath: string) {
  const raw = await NodeFSP.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const hermesAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-hermes-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (binaryPath: string, options?: Parameters<typeof makeHermesAdapter>[1]) =>
  makeHermesAdapter(decodeHermesSettings({ binaryPath }), options).pipe(Effect.orDie);

function hermesPermissionRequest(
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

it("maps Always allow to allow_once when Hermes omits allow_always", () => {
  const request = hermesPermissionRequest([
    { optionId: "allow-once", kind: "allow_once" },
    { optionId: "reject-once", kind: "reject_once" },
  ]);

  assert.equal(selectHermesPermissionOptionId(request, "acceptForSession"), "allow-once");
  assert.equal(selectHermesPermissionOptionId(request, "accept"), "allow-once");
  assert.equal(selectHermesPermissionOptionId(request, "decline"), "reject-once");
});

it("prefers allow_always when Hermes offers it", () => {
  const request = hermesPermissionRequest([
    { optionId: "allow-once", kind: "allow_once" },
    { optionId: "allow-always", kind: "allow_always" },
    { optionId: "reject-once", kind: "reject_once" },
  ]);

  assert.equal(selectHermesPermissionOptionId(request, "acceptForSession"), "allow-always");
  assert.equal(selectHermesPermissionOptionId(request, "accept"), "allow-once");
});

it("returns undefined when Hermes offers no matching option kind", () => {
  const request = hermesPermissionRequest([{ optionId: "reject-once", kind: "reject_once" }]);
  assert.isUndefined(selectHermesPermissionOptionId(request, "accept"));
});

it("falls back to reject_always when Hermes omits reject_once", () => {
  const request = hermesPermissionRequest([
    { optionId: "allow-once", kind: "allow_once" },
    { optionId: "reject-always", kind: "reject_always" },
  ]);

  assert.equal(selectHermesPermissionOptionId(request, "decline"), "reject-always");
});

it.layer(hermesAdapterTestLayer)("makeHermesAdapter against the mock ACP agent", (it) => {
  it.effect("starts a session and maps mock ACP prompt flow to runtime events", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-mock-thread");
      const wrapperPath = yield* Effect.promise(() => makeMockHermesWrapper());
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
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("hermes"), model: "grok-mock-alt" },
      });

      assert.equal(session.provider, "hermes");
      assert.equal(session.model, "grok-mock-alt");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "hello hermes",
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

  it.effect.skipIf(windowsHost)("closes the ACP child process when a session stops", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-stop-session-close");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-adapter-exit-log-")),
      );
      const exitLogPath = NodePath.join(tempDir, "exit.log");

      const wrapperPath = yield* Effect.promise(() =>
        makeMockHermesWrapper({ T3_ACP_EXIT_LOG_PATH: exitLogPath }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("hermes"), model: "hermes-agent" },
      });

      yield* adapter.stopSession(threadId);

      const exitLog = yield* waitForFileContent(exitLogPath);
      assert.include(exitLog, "SIGTERM");
    }),
  );

  // it.effect provides a virtual TestClock: Effect.sleep-based races (the
  // probe's own Effect.timeoutOrElse) never elapse without an explicit
  // TestClock.adjust, so the fiber is forked and the clock advanced by hand
  // rather than waiting on real time.
  it.effect.skipIf(windowsHost)(
    "fails startSession within the auth-method probe timeout when Hermes never answers 'initialize', and kills the probe process",
    () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("hermes-hung-auth-probe");
        const tempDir = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-adapter-probe-exit-log-")),
        );
        const exitLogPath = NodePath.join(tempDir, "exit.log");

        const wrapperPath = yield* Effect.promise(() =>
          makeMockHermesWrapper({
            T3_ACP_HANG_INITIALIZE: "1",
            T3_ACP_EXIT_LOG_PATH: exitLogPath,
          }),
        );
        const adapter = yield* makeTestAdapter(wrapperPath, { authMethodProbeTimeoutMs: 200 });

        const resultFiber = yield* adapter
          .startSession({
            threadId,
            provider: ProviderDriverKind.make("hermes"),
            cwd: process.cwd(),
            runtimeMode: "full-access",
            modelSelection: {
              instanceId: ProviderInstanceId.make("hermes"),
              model: "hermes-agent",
            },
          })
          .pipe(Effect.flip, Effect.forkChild);

        // Give the mock agent's real child process time to actually spawn
        // and register its own SIGTERM handler before firing the probe's
        // internal 200ms timeoutOrElse — a real delay, since the virtual
        // TestClock advances instantly regardless of real elapsed time.
        yield* Effect.promise(
          () =>
            new Promise((resolve) => {
              // @effect-diagnostics-next-line globalTimers:off -- real wall-clock delay, not a virtual-clock wait.
              setTimeout(resolve, 500);
            }),
        );
        yield* TestClock.adjust("1 second");
        const failure = yield* Fiber.join(resultFiber);

        // AcpTransportError's generic `.message` getter surfaces here; the
        // rich "did not respond to 'initialize'" text lives on `.detail`,
        // which mapAcpToAdapterError does not thread into `.message`.
        assert.include(failure.message ?? "", "ACP transport operation failed");

        // Guaranteed child termination: the probe scope's finalizer must have
        // killed the hung process on timeout — confirmed by the mock agent's
        // own SIGTERM handler firing. Polls with a real (non-Effect.sleep)
        // delay so it is not itself frozen by the virtual TestClock.
        const exitLog = yield* Effect.promise(async () => {
          for (let attempt = 0; attempt < 80; attempt += 1) {
            const raw = await NodeFSP.readFile(exitLogPath, "utf8").catch(() => "");
            if (raw.trim().length > 0) return raw;
            // @effect-diagnostics-next-line globalTimers:off -- real wall-clock delay; this poll must not use Effect.sleep, which the virtual TestClock freezes.
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          throw new Error(`Timed out waiting for file content at ${exitLogPath}`);
        });
        assert.include(exitLog, "SIGTERM");
      }),
  );

  it.effect("caches the auth-method id across startSession calls within the TTL", () =>
    Effect.gen(function* () {
      resetHermesAcpAuthMethodIdCacheForTests();
      const argvLogPath = yield* Effect.promise(async () => {
        const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-argv-log-"));
        return NodePath.join(dir, "argv.log");
      });
      const wrapperPath = yield* Effect.promise(() =>
        makeMockHermesWrapper(undefined, { argvLogPath }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const threadId1 = ThreadId.make("hermes-auth-cache-1");
      yield* adapter.startSession({
        threadId: threadId1,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("hermes"), model: "hermes-agent" },
      });
      yield* adapter.stopSession(threadId1);

      const threadId2 = ThreadId.make("hermes-auth-cache-2");
      yield* adapter.startSession({
        threadId: threadId2,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("hermes"), model: "hermes-agent" },
      });
      yield* adapter.stopSession(threadId2);

      const argvLog = yield* Effect.promise(() => NodeFSP.readFile(argvLogPath, "utf8"));
      const spawnCount = argvLog.split("\n").filter((line) => line.trim().length > 0).length;
      // Without caching this would be 4 (probe + real session per call).
      // With the auth-method id cached after the first call, the second
      // startSession skips its probe spawn, dropping the total to 3.
      assert.equal(spawnCount, 3);
    }),
  );

  it.effect("fails respondToUserInput for an unknown pending request id", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-no-user-input");
      const wrapperPath = yield* Effect.promise(() => makeMockHermesWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("hermes"), model: "hermes-agent" },
      });

      const failure = yield* adapter
        .respondToUserInput(threadId, ApprovalRequestId.make("not-a-real-request"), {})
        .pipe(Effect.flip);
      assert.include(failure.message ?? "", "Unknown pending user-input request");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("resolves a session/elicitation request through respondToUserInput", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-elicitation");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockHermesWrapper({ T3_ACP_EMIT_ELICITATION: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const requested =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.requested" }>>();
      const resolved =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.resolved" }>>();
      const turnCompleted = yield* Deferred.make<void>();
      const contentDeltas: string[] = [];

      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (String(event.threadId) !== String(threadId)) {
          return Effect.void;
        }
        if (event.type === "content.delta") {
          contentDeltas.push(event.payload.delta);
        }
        if (event.type === "user-input.requested") {
          return Deferred.succeed(requested, event).pipe(Effect.ignore);
        }
        if (event.type === "user-input.resolved") {
          return Deferred.succeed(resolved, event).pipe(Effect.ignore);
        }
        if (event.type === "turn.completed") {
          return Deferred.succeed(turnCompleted, undefined).pipe(Effect.ignore);
        }
        return Effect.void;
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("hermes"), model: "hermes-agent" },
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "please pick a color", attachments: [] })
        .pipe(Effect.forkChild);

      const requestedEvent = yield* Deferred.await(requested);
      assert.equal(requestedEvent.raw?.method, "session/elicitation");
      assert.equal(requestedEvent.payload.questions.length, 1);
      const question = requestedEvent.payload.questions[0];
      assert.equal(question?.id, "color");
      assert.deepStrictEqual(
        question?.options.map((option) => option.label),
        ["red", "blue"],
      );

      yield* adapter.respondToUserInput(
        threadId,
        ApprovalRequestId.make(String(requestedEvent.requestId)),
        { color: "blue" },
      );

      const resolvedEvent = yield* Deferred.await(resolved);
      assert.deepStrictEqual(resolvedEvent.payload.answers, { color: "blue" });

      yield* Deferred.await(turnCompleted);
      yield* Fiber.join(sendTurnFiber);
      yield* Fiber.interrupt(eventsFiber);

      assert.isTrue(
        contentDeltas.some((delta) =>
          delta.includes('elicitation-response:{"action":"accept","content":{"color":"blue"}}'),
        ),
      );

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect(
    "reports a failed mid-turn model switch as a warning without touching the still-running original turn",
    () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("hermes-model-switch-failure");
        const wrapperPath = yield* Effect.promise(() =>
          makeMockHermesWrapper({
            T3_ACP_FAIL_SET_SESSION_MODEL: "1",
            T3_ACP_PROMPT_DELAY_MS: "300",
          }),
        );
        const adapter = yield* makeTestAdapter(wrapperPath);

        const completedEvents: Array<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>> =
          [];
        const warningEvents: Array<Extract<ProviderRuntimeEvent, { type: "runtime.warning" }>> = [];
        const firstCompleted = yield* Deferred.make<void>();
        const warningSeen = yield* Deferred.make<void>();
        const firstTurnStarted = yield* Deferred.make<void>();
        const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) => {
          if (String(event.threadId) !== String(threadId)) {
            return Effect.void;
          }
          if (event.type === "turn.started") {
            return Deferred.succeed(firstTurnStarted, undefined).pipe(Effect.ignore);
          }
          if (event.type === "runtime.warning") {
            warningEvents.push(event);
            return Deferred.succeed(warningSeen, undefined).pipe(Effect.ignore);
          }
          if (event.type !== "turn.completed") {
            return Effect.void;
          }
          completedEvents.push(event);
          return Deferred.succeed(firstCompleted, undefined).pipe(Effect.ignore);
        }).pipe(Effect.forkChild);

        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("hermes"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: { instanceId: ProviderInstanceId.make("hermes"), model: "hermes-agent" },
        });

        // Turn A dispatches session/prompt normally; the mock delays its
        // response by 300ms, keeping it "in flight" while the steer below
        // runs and fails.
        const firstTurnFiber = yield* adapter
          .sendTurn({ threadId, input: "turn A", attachments: [] })
          .pipe(Effect.forkChild);

        // Wait for turn A's own prepare phase (which sets ctx.activeTurnId
        // and emits turn.started before ever dispatching session/prompt) so
        // the steer below is unambiguously recognized as steering rather
        // than racing turn A for "first turn" status.
        yield* Deferred.await(firstTurnStarted);

        // Steer with a different model while turn A is still active. Hermes
        // rejects session/set_model mid-turn (mocked as -32603 internal
        // error). This must not settle turn A, must not flip session status,
        // and must report the failure as a non-terminal warning instead.
        const steerResult = yield* adapter.sendTurn({
          threadId,
          input: "steer with a different model",
          attachments: [],
          modelSelection: { instanceId: ProviderInstanceId.make("hermes"), model: "grok-mock-alt" },
        });
        assert.equal(String(steerResult.threadId), String(threadId));

        yield* Deferred.await(warningSeen);
        // The steer's own failure settles synchronously; turn A is still
        // streaming at this point, so no turn.completed has landed yet.
        assert.equal(completedEvents.length, 0);

        yield* Deferred.await(firstCompleted);
        yield* Fiber.join(firstTurnFiber);
        yield* Fiber.interrupt(eventsFiber);

        // Exactly one warning (the dropped steer) and exactly one
        // turn.completed (turn A resolving on its own), both for the same
        // turn id — the failed model switch never allocates its own turn.
        assert.equal(warningEvents.length, 1);
        assert.include(warningEvents[0]?.payload.message ?? "", "Failed to switch model");
        assert.equal(completedEvents.length, 1);
        assert.equal(completedEvents[0]?.payload.state, "completed");
        assert.equal(String(warningEvents[0]?.turnId), String(completedEvents[0]?.turnId));

        yield* adapter.stopSession(threadId);
      }),
  );

  it.effect(
    "attributes a content delta queued before the prompt resolves to the finished turn, not the next one",
    () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("hermes-trailing-delta");
        const wrapperPath = yield* Effect.promise(() =>
          makeMockHermesWrapper({ T3_ACP_EMIT_TRAILING_DELTA_BEFORE_COMPLETE: "1" }),
        );
        const adapter = yield* makeTestAdapter(wrapperPath);

        const contentDeltas: Array<Extract<ProviderRuntimeEvent, { type: "content.delta" }>> = [];
        const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            if (event.type === "content.delta" && String(event.threadId) === String(threadId)) {
              contentDeltas.push(event);
            }
          }),
        ).pipe(Effect.forkChild);

        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("hermes"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: { instanceId: ProviderInstanceId.make("hermes"), model: "hermes-agent" },
        });

        // The mock writes a "trailing-delta" session/update notification to
        // the wire immediately before responding to this prompt, so it is
        // already queued in the client's event stream by the time sendTurn
        // resolves below — before this test gets a chance to start turn 2.
        const firstTurn = yield* adapter.sendTurn({
          threadId,
          input: "first turn",
          attachments: [],
        });

        const secondTurn = yield* adapter.sendTurn({
          threadId,
          input: "second turn",
          attachments: [],
        });

        yield* Fiber.interrupt(eventsFiber);

        const trailingDelta = contentDeltas.find(
          (event) => event.payload.delta === "trailing-delta",
        );
        assert.isDefined(trailingDelta);
        assert.equal(String(trailingDelta?.turnId), String(firstTurn.turnId));
        assert.notEqual(String(trailingDelta?.turnId), String(secondTurn.turnId));

        yield* adapter.stopSession(threadId);
      }),
  );

  it.effect(
    "serializes cancel-then-dispatch through promptLifecycle so a rapid double-steer cancels the middle prompt",
    () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("hermes-double-steer");
        const tempDir = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-double-steer-log-")),
        );
        const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
        const wrapperPath = yield* Effect.promise(() =>
          makeMockHermesWrapper({
            T3_ACP_REQUEST_LOG_PATH: requestLogPath,
            T3_ACP_PROMPT_DELAY_MS: "300",
          }),
        );
        const adapter = yield* makeTestAdapter(wrapperPath);

        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("hermes"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: { instanceId: ProviderInstanceId.make("hermes"), model: "hermes-agent" },
        });

        const turn1Fiber = yield* adapter
          .sendTurn({ threadId, input: "turn 1", attachments: [] })
          .pipe(Effect.forkChild);
        // Wait for turn 1's prompt to actually reach the wire (not just for
        // its prepare phase / turn.started, which fires before
        // promptLifecycle is even entered) so the race below is
        // unambiguously "two steers against one already-dispatched turn."
        yield* waitForFileContentReal(requestLogPath, 120, '"method":"session/prompt"');

        // Two steers back to back, with no wait between them, so the second
        // reaches promptLifecycle while the first may still be inside its
        // own cancel-then-dispatch sequence.
        const steerAFiber = yield* adapter
          .sendTurn({ threadId, input: "steer A", attachments: [] })
          .pipe(Effect.forkChild);
        const steerBFiber = yield* adapter
          .sendTurn({ threadId, input: "steer B", attachments: [] })
          .pipe(Effect.forkChild);

        yield* Fiber.join(turn1Fiber);
        yield* Fiber.join(steerAFiber);
        yield* Fiber.join(steerBFiber);

        const requestLog = yield* Effect.promise(() => readJsonLines(requestLogPath));
        const methodSequence = requestLog
          .map((entry) => entry.method)
          .filter((method) => method === "session/cancel" || method === "session/prompt");

        // promptLifecycle guarantees a prompt is never dispatched while an
        // earlier one is still active and uncancelled: every session/prompt
        // after the first must have at least one session/cancel since the
        // previous session/prompt. A steer that gets superseded mid-cancel
        // (before it can dispatch its own replacement) may cancel again
        // redundantly — that is wasteful but harmless. What promptLifecycle
        // rules out is the actual bug: a later prompt (steer B) dispatching
        // with *zero* intervening cancels since the previous prompt (steer
        // A), which would let steer A run to completion unobserved.
        const promptIndices = methodSequence
          .map((method, index) => (method === "session/prompt" ? index : -1))
          .filter((index) => index >= 0);
        assert.isAtLeast(
          promptIndices.length,
          2,
          "expected at least turn 1 plus one winning steer",
        );
        for (let i = 1; i < promptIndices.length; i += 1) {
          const previousIndex = promptIndices[i - 1] ?? -1;
          const currentIndex = promptIndices[i] ?? -1;
          const sincePrevious = methodSequence.slice(previousIndex + 1, currentIndex);
          assert.include(
            sincePrevious,
            "session/cancel",
            `expected at least one session/cancel between prompt #${i} and prompt #${i + 1}`,
          );
        }

        yield* adapter.stopSession(threadId);
      }),
  );

  // withRealTimeout, not Effect.timeout: it.layer's TestClock never
  // advances on its own (nothing calls TestClock.adjust), so a genuine hang
  // and a passing run would look identical under a virtual-clock timeout —
  // defeating the point of this test.
  it.effect(
    "queues follow-up turns issued while turn A is active and settles each in turn, without hanging",
    () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("hermes-queued-followups");
        const wrapperPath = yield* Effect.promise(() =>
          makeMockHermesWrapper({ T3_ACP_PROMPT_DELAY_MS: "150" }),
        );
        const adapter = yield* makeTestAdapter(wrapperPath);

        const turnStarted = yield* Deferred.make<void>();
        const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          event.type === "turn.started" && String(event.threadId) === String(threadId)
            ? Deferred.succeed(turnStarted, undefined).pipe(Effect.ignore)
            : Effect.void,
        ).pipe(Effect.forkChild);

        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("hermes"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: { instanceId: ProviderInstanceId.make("hermes"), model: "hermes-agent" },
        });

        // Turn A dispatches and is still active (150ms mock delay) when B
        // and C are issued — the live bug's shape: follow-ups sent while a
        // turn is running must never be lost or leave sendTurn hanging.
        const aFiber = yield* withRealTimeout(
          adapter.sendTurn({ threadId, input: "turn A", attachments: [] }),
          5_000,
        ).pipe(Effect.forkChild);
        yield* withRealTimeout(Deferred.await(turnStarted), 5_000);

        const bFiber = yield* withRealTimeout(
          adapter.sendTurn({ threadId, input: "turn B", attachments: [] }),
          5_000,
        ).pipe(Effect.forkChild);
        const cFiber = yield* withRealTimeout(
          adapter.sendTurn({ threadId, input: "turn C", attachments: [] }),
          5_000,
        ).pipe(Effect.forkChild);

        const a = yield* Fiber.join(aFiber);
        const b = yield* Fiber.join(bFiber);
        const c = yield* Fiber.join(cFiber);

        yield* Fiber.interrupt(eventsFiber);

        assert.isDefined(a.turnId);
        assert.isDefined(b.turnId);
        assert.isDefined(c.turnId);

        yield* adapter.stopSession(threadId);
      }),
  );

  it.effect(
    "waits for turn A's prompt to actually return before dispatching a mid-turn follow-up, instead of racing a second session/prompt onto the wire while Hermes still considers the first active",
    () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("hermes-midturn-followup-waits");
        const tempDir = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-midturn-followup-log-")),
        );
        const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
        const wrapperPath = yield* Effect.promise(() =>
          makeMockHermesWrapper({
            T3_ACP_REQUEST_LOG_PATH: requestLogPath,
            T3_ACP_PROMPT_DELAY_MS: "300",
          }),
        );
        const adapter = yield* makeTestAdapter(wrapperPath);

        const completedEvents: Array<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>> =
          [];
        const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            if (event.type === "turn.completed" && String(event.threadId) === String(threadId)) {
              completedEvents.push(event);
            }
          }),
        ).pipe(Effect.forkChild);

        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("hermes"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: { instanceId: ProviderInstanceId.make("hermes"), model: "hermes-agent" },
        });

        const turnAFiber = yield* adapter
          .sendTurn({ threadId, input: "turn A", attachments: [] })
          .pipe(Effect.forkChild);

        // Wait for turn A's prompt to actually reach the wire before issuing
        // the follow-up, so the follow-up is unambiguously a mid-turn steer.
        yield* waitForFileContentReal(requestLogPath, 120, '"method":"session/prompt"');

        const followUpFiber = yield* adapter
          .sendTurn({ threadId, input: "follow-up", attachments: [] })
          .pipe(Effect.forkChild);

        // Real wall-clock wait (not the virtual TestClock), well short of
        // turn A's 300ms mock delay. The fix's order is session/cancel,
        // then genuinely wait for turn A's real prompt response (the
        // session runs with cancelBehavior: "wait-for-prompt" —
        // HermesAcpSupport.ts — so cancel() itself blocks on it), then
        // dispatch. A pre-fix adapter (or the runtime's default
        // cancelBehavior: "interrupt", which synthesizes an instant
        // `cancelled` result instead of observing Hermes's real response)
        // would have the follow-up's session/prompt land in this window.
        yield* Effect.promise(
          () =>
            new Promise((resolve) => {
              // @effect-diagnostics-next-line globalTimers:off -- real wall-clock wait; the virtual TestClock never advances this.
              setTimeout(resolve, 150);
            }),
        );
        const midWindowLog = yield* Effect.promise(() => readJsonLines(requestLogPath));
        assert.equal(
          midWindowLog.filter((entry) => entry.method === "session/prompt").length,
          1,
          "the follow-up's session/prompt must not reach the wire before turn A's own prompt returned",
        );

        yield* withRealTimeout(Fiber.join(turnAFiber), 5_000);
        yield* withRealTimeout(Fiber.join(followUpFiber), 5_000);
        yield* Fiber.interrupt(eventsFiber);

        const requestLog = yield* Effect.promise(() => readJsonLines(requestLogPath));
        const methodSequence = requestLog
          .map((entry) => entry.method)
          .filter((method) => method === "session/cancel" || method === "session/prompt");
        assert.deepEqual(methodSequence, ["session/prompt", "session/cancel", "session/prompt"]);

        // The follow-up (the winning dispatch) settles the shared turn
        // exactly once; turn A's own now-superseded call stays silent.
        assert.equal(completedEvents.length, 1);
        assert.equal(completedEvents[0]?.payload.state, "completed");

        yield* adapter.stopSession(threadId);
      }),
  );

  it.effect(
    "drops a mid-turn steer without dispatching when turn A's prompt never returns within the wait bound",
    () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("hermes-steer-await-timeout");
        const tempDir = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-steer-timeout-log-")),
        );
        const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
        const wrapperPath = yield* Effect.promise(() =>
          makeMockHermesWrapper({
            T3_ACP_REQUEST_LOG_PATH: requestLogPath,
            T3_ACP_HANG_FIRST_PROMPT_FOREVER: "1",
          }),
        );
        const adapter = yield* makeTestAdapter(wrapperPath);

        const warningEvents: Array<Extract<ProviderRuntimeEvent, { type: "runtime.warning" }>> = [];
        const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            if (event.type === "runtime.warning" && String(event.threadId) === String(threadId)) {
              warningEvents.push(event);
            }
          }),
        ).pipe(Effect.forkChild);

        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("hermes"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: { instanceId: ProviderInstanceId.make("hermes"), model: "hermes-agent" },
        });

        // Turn A's prompt hangs forever (T3_ACP_HANG_FIRST_PROMPT_FOREVER):
        // it never returns, so the steer below must hit the wait bound
        // rather than block forever or dispatch on top of it.
        const turnAFiber = yield* adapter
          .sendTurn({ threadId, input: "turn A (hangs forever)", attachments: [] })
          .pipe(Effect.forkChild);
        yield* waitForFileContentReal(requestLogPath, 120, '"method":"session/prompt"');

        const steerFiber = yield* adapter
          .sendTurn({ threadId, input: "steer while A hangs", attachments: [] })
          .pipe(Effect.forkChild);
        // The fix waits for turn A's real prompt before ever sending
        // session/cancel (see the steering branch's comment in
        // HermesAdapter.ts), so there is no wire-level signal to
        // synchronize on here. The steer's pre-wait work (settling pending
        // approvals/user-inputs against empty maps) is synchronous local
        // state, so a short real-clock pause is enough to let it reach the
        // bounded await before the virtual clock advances past it.
        yield* Effect.promise(
          () =>
            new Promise((resolve) => {
              // @effect-diagnostics-next-line globalTimers:off -- real wall-clock wait; the virtual TestClock never advances this.
              setTimeout(resolve, 50);
            }),
        );

        yield* TestClock.adjust("31 seconds");

        yield* withRealTimeout(Fiber.join(steerFiber), 5_000);
        yield* Fiber.interrupt(turnAFiber);
        yield* Fiber.interrupt(eventsFiber);

        assert.equal(warningEvents.length, 1);
        assert.include(
          warningEvents[0]?.payload.message ?? "",
          "Timed out after 30000ms waiting for the previous prompt to finish cancelling",
        );

        const requestLog = yield* Effect.promise(() => readJsonLines(requestLogPath));
        const promptCount = requestLog.filter((entry) => entry.method === "session/prompt").length;
        assert.equal(
          promptCount,
          1,
          "the steer must never dispatch a second session/prompt after timing out",
        );

        yield* adapter.stopSession(threadId);
      }),
  );

  it.effect(
    "settles the turn as failed instead of presenting the text when Hermes's response is its own queue-absorption reply",
    () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("hermes-absorbed-queue-marker");
        const wrapperPath = yield* Effect.promise(() =>
          makeMockHermesWrapper({
            T3_ACP_PROMPT_RESPONSE_TEXT: "Queued for the next turn. (1 queued)",
          }),
        );
        const adapter = yield* makeTestAdapter(wrapperPath);

        const completedEvents: Array<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>> =
          [];
        const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            if (event.type === "turn.completed" && String(event.threadId) === String(threadId)) {
              completedEvents.push(event);
            }
          }),
        ).pipe(Effect.forkChild);

        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("hermes"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: { instanceId: ProviderInstanceId.make("hermes"), model: "hermes-agent" },
        });

        yield* adapter.sendTurn({ threadId, input: "hello", attachments: [] });
        yield* Fiber.interrupt(eventsFiber);

        assert.equal(completedEvents.length, 1);
        const completed = completedEvents[0];
        assert.equal(completed?.payload.state, "failed");
        if (completed?.payload.state === "failed") {
          assert.equal(
            completed.payload.errorMessage,
            "Hermes absorbed the prompt into its internal queue; the adapter dispatched while a turn was running",
          );
        }

        yield* adapter.stopSession(threadId);
      }),
  );

  it.effect(
    "retries startSession once with a fresh probe when the cached auth method id is stale",
    () =>
      Effect.gen(function* () {
        resetHermesAcpAuthMethodIdCacheForTests();
        const threadId = ThreadId.make("hermes-stale-auth-retry");
        const stateDir = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-stale-auth-state-")),
        );
        const wrapperPath = yield* Effect.promise(() =>
          makeMockHermesWrapper({
            T3_ACP_STALE_AUTH_METHOD_ONCE: "1",
            T3_ACP_STALE_AUTH_METHOD_STATE_PATH: NodePath.join(stateDir, "state"),
          }),
        );
        const adapter = yield* makeTestAdapter(wrapperPath);

        // The very first startSession already exercises the retry: nothing
        // has cached "stale-method" ahead of time, so the initial attempt
        // resolves it fresh, gets rejected by authenticate, invalidates the
        // cache, re-probes (now "fresh-method"), and succeeds.
        const session = yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("hermes"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: { instanceId: ProviderInstanceId.make("hermes"), model: "hermes-agent" },
        });
        assert.equal(session.provider, "hermes");

        yield* adapter.stopSession(threadId);
      }),
  );

  it.effect(
    "surfaces an error naming both attempted auth methods when Hermes rejects authentication twice",
    () =>
      Effect.gen(function* () {
        resetHermesAcpAuthMethodIdCacheForTests();
        const threadId = ThreadId.make("hermes-double-auth-failure");
        const wrapperPath = yield* Effect.promise(() =>
          makeMockHermesWrapper({ T3_ACP_STALE_AUTH_METHOD_ALWAYS: "1" }),
        );
        const adapter = yield* makeTestAdapter(wrapperPath);

        const failure = yield* adapter
          .startSession({
            threadId,
            provider: ProviderDriverKind.make("hermes"),
            cwd: process.cwd(),
            runtimeMode: "full-access",
            modelSelection: {
              instanceId: ProviderInstanceId.make("hermes"),
              model: "hermes-agent",
            },
          })
          .pipe(Effect.flip);

        assert.include(failure.message ?? "", "stale-method");
      }),
  );
});
