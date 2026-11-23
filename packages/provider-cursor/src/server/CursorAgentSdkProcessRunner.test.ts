import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import { AgentScope } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as CursorAgentSdk from "./CursorAgentSdk.ts";
import * as CursorAgentSdkProcessRunner from "./CursorAgentSdkProcessRunner.ts";
import {
  deserializeRunResult,
  deserializeWorkerError,
  serializeRunResult,
  serializeWorkerError,
} from "./CursorAgentSdkWorkerProtocol.ts";
import { isCursorSdkError, tagCursorSdkError } from "./sdk.ts";

// Minimal fake worker script implementing the NDJSON worker protocol in a real child Node process.
const FAKE_WORKER_SCRIPT = `
const readline = require("node:readline");
const rawWrite = process.stdout.write.bind(process.stdout);
const send = (msg) => rawWrite(JSON.stringify(msg) + "\\n");
const mode = process.env.FAKE_WORKER_MODE || "ok";

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  if (req.type === "open") {
    if (mode === "config-error") {
      send({
        type: "response",
        id: req.id,
        ok: false,
        error: {
          method: "agent.create",
          cause: {
            name: "ConfigurationError",
            message: "Cannot use this model: bad-model",
            sdkErrorKind: "ConfigurationError",
          },
        },
      });
      return;
    }
    rawWrite("non-json noise that must be ignored\\n");
    send({ type: "response", id: req.id, ok: true, result: { agentId: "agent-worker-1" } });
    return;
  }
  if (req.type === "send") {
    if (mode === "hang-send") {
      send({ type: "protocolLog", providerSessionId: "provider-session-worker-test", event: { direction: "incoming", stage: "decoded", payload: { type: "run.started", runId: "pending", agentId: "agent-worker-1" } } });
      return;
    }
    if (mode === "crash-mid-run") {
      send({ type: "response", id: req.id, ok: true, result: { runId: "run-crash", agentId: "agent-worker-1" } });
      process.stderr.write("fatal worker boom\\n");
      process.exit(17);
      return;
    }
    // Emit an early delta before the send response to verify parent buffering/ordering.
    send({ type: "startupPhase", sendId: req.id, phase: "plugins" });
    send({ type: "delta", sendId: req.id, update: { type: "text-delta", text: "early-" } });
    send({ type: "response", id: req.id, ok: true, result: { runId: "run-worker-1", agentId: "agent-worker-1" } });
    if (mode === "cancel") {
      return;
    }
    send({ type: "delta", sendId: req.id, update: { type: "text-delta", text: "late" } });
    send({
      type: "runDone",
      sendId: req.id,
      ok: true,
      result: {
        id: "run-worker-1",
        requestId: "req-1",
        status: "finished",
        result: "early-late",
        model: { id: "default" },
        durationMs: 5,
      },
    });
    if (mode === "exit-after-done") {
      rawWrite("", () => process.exit(0));
    }
    if (mode === "background-shell" && req.listenBackgroundShells) {
      send({ type: "backgroundShell", sessionId: req.sessionId, event: { type: "started", id: "sh-1", pid: 4101, command: "sleep 60" } });
      send({ type: "backgroundShell", sessionId: req.sessionId, event: { type: "started", id: "sh-2", pid: 4102, command: "tail -f" } });
    }
    return;
  }
  if (req.type === "stopBackgroundShell") {
    send({ type: "backgroundShell", sessionId: req.sessionId, event: { type: "ended", id: req.shellId, pid: 4101, command: "sleep 60", stopped: true, exitCode: undefined, outputPath: undefined } });
    send({ type: "response", id: req.id, ok: true, result: null });
    if (mode === "background-shell") {
      rawWrite("", () => process.exit(19));
    }
    return;
  }
  if (req.type === "steer") {
    send({ type: "response", id: req.id, ok: true, result: "complete_delivered" });
    return;
  }
  if (req.type === "cancel") {
    send({ type: "protocolLog", providerSessionId: "provider-session-worker-test", event: { direction: "incoming", stage: "decoded", payload: { type: "run.cancel", runId: "run-worker-1" } } });
    send({ type: "response", id: req.id, ok: true, result: null });
    send({
      type: "runDone",
      sendId: req.sendId,
      ok: true,
      result: {
        id: "run-worker-1",
        requestId: "req-1",
        status: "cancelled",
        model: { id: "default" },
        durationMs: 2,
      },
    });
    return;
  }
  if (req.type === "listMessages") {
    send({ type: "response", id: req.id, ok: true, result: [{ id: "m1", role: "assistant", text: "early-late" }] });
    return;
  }
  if (req.type === "readContextUsage") {
    send({ type: "response", id: req.id, ok: true, result: { usedTokens: 120, maxTokens: 1000 } });
    return;
  }
  if (req.type === "runCheckpointed") {
    send({ type: "response", id: req.id, ok: true, result: req.runId === "run-worker-1" });
    return;
  }
  if (req.type === "rewindAfterRun") {
    send({ type: "response", id: req.id, ok: true, result: null });
    return;
  }
  if (req.type === "textGenerate" && mode === "hang-text") {
    send({ type: "protocolLog", providerSessionId: "provider-session-worker-test", event: { direction: "incoming", stage: "decoded", payload: { type: "run.started", runId: "text", agentId: "text" } } });
    return;
  }
  if (req.type === "cancelTextGenerate") {
    send({ type: "protocolLog", providerSessionId: "provider-session-worker-test", event: { direction: "incoming", stage: "decoded", payload: { type: "run.cancel", runId: "text" } } });
    send({ type: "response", id: req.id, ok: true, result: null });
    return;
  }
  if (req.type === "textGenerate") {
    if (mode === "rate-limit-text") {
      send({
        type: "response",
        id: req.id,
        ok: true,
        result: {
          id: "run-tg-1",
          requestId: "req-tg-1",
          status: "error",
          model: { id: "default" },
          durationMs: 3,
          error: {
            name: "RateLimitError",
            message: "Too many requests",
            code: "PRO_USER_USAGE_LIMIT",
            status: 429,
            sdkErrorKind: "CursorSdkError",
          },
        },
      });
      return;
    }
    send({
      type: "response",
      id: req.id,
      ok: true,
      result: {
        id: "run-tg-1",
        requestId: "req-tg-1",
        status: "finished",
        result: JSON.stringify({ title: "Out of process" }),
        model: { id: "default" },
        durationMs: 3,
      },
    });
    return;
  }
  if (req.type === "closeSession") {
    send({ type: "response", id: req.id, ok: true, result: null });
    return;
  }
  if (req.type === "close") {
    send({ type: "response", id: req.id, ok: true, result: null });
    rawWrite("", () => process.exit(0));
  }
});
rl.on("close", () => process.exit(0));
`;

const openInput = {
  operation: "create" as const,
  options: { model: { id: "default" } },
  threadId: ThreadId.make("thread-worker-test"),
  providerSessionId: ProviderSessionId.make("provider-session-worker-test"),
};

describe("CursorAgentSdkWorkerProtocol", () => {
  it("preserves SDK error classification, rate limits, and abort causes without loading @cursor/sdk", () => {
    const configErr = tagCursorSdkError(
      new Error("Cannot use this model: mystery"),
      "ConfigurationError",
    );
    const restoredConfig = deserializeWorkerError(serializeWorkerError(configErr));
    assert.isTrue(isCursorSdkError(restoredConfig, "ConfigurationError"));
    assert.isTrue(isCursorSdkError(restoredConfig, "CursorSdkError"));
    assert.isFalse(isCursorSdkError(restoredConfig, "AuthenticationError"));

    const rateErr = Object.assign(new Error("Quota exceeded"), {
      name: "RateLimitError",
      code: "PRO_USER_USAGE_LIMIT",
      status: 429,
    });
    const restoredResult = deserializeRunResult(
      serializeRunResult({
        id: "r1",
        requestId: "req1",
        status: "error",
        model: { id: "default" },
        durationMs: 1,
        error: rateErr,
      } as never),
    );
    assert.isTrue(CursorAgentSdk.isCursorUsageLimitError(restoredResult.error));
    assert.equal(restoredResult.error?.message, "Quota exceeded");

    const abortInner = Object.assign(new Error("aborted"), { name: "AbortError" });
    const wrappedAbort = new Error("outer", { cause: abortInner });
    const restoredAbort = deserializeWorkerError(serializeWorkerError(wrappedAbort));
    assert.isTrue(CursorAgentSdk.isCursorCancellationError(restoredAbort));

    const nullProto = Object.create(null) as Record<string, unknown>;
    const restoredNullProto = deserializeWorkerError(serializeWorkerError(nullProto));
    assert.equal(restoredNullProto.message, "[Unserializable error]");
  });
});

describe("CursorAgentSdkProcessRunner", () => {
  const writeFakeWorker = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cursor-worker-test-" });
    const scriptPath = path.join(dir, "fake-worker.cjs");
    yield* fs.writeFileString(scriptPath, FAKE_WORKER_SCRIPT);
    return scriptPath;
  });

  it.live(
    "runs a full session out of process with ordered deltas, scope hooks, and clean shutdown",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const scriptPath = yield* writeFakeWorker;
          const executable = yield* HostProcess.ExecutablePath;
          const registeredPids: Array<number> = [];
          const unregisteredPids: Array<number> = [];
          const stoppedUnits: Array<string> = [];
          const protocolEvents: Array<string> = [];

          const runner = yield* CursorAgentSdkProcessRunner.makeCursorAgentSdkProcessRunner({
            resolveLaunch: Effect.succeed({
              command: executable,
              args: [scriptPath],
              registerProcess: (pid) => {
                registeredPids.push(pid);
                return () => unregisteredPids.push(pid);
              },
            }),
            protocolLoggerFor: () => (event) =>
              Effect.sync(() => {
                protocolEvents.push(event.payload.type);
              }),
          }).pipe(
            Effect.provideService(AgentScope, {
              wrap: ({ command, args, name }) =>
                Effect.succeed({ command, args, unit: `unit-${name}` }),
              oomKilled: () => Effect.succeed(false),
              stop: (unit) =>
                Effect.sync(() => {
                  stoppedUnits.push(unit);
                }),
              kill: () => Effect.succeed(false),
              clear: () => Effect.void,
            }),
          );

          const session = yield* runner.open(openInput);
          assert.equal(session.agentId, "agent-worker-1");
          assert.isTrue(session.isAlive?.());
          const otherSession = yield* runner.open({
            ...openInput,
            threadId: ThreadId.make("thread-worker-test-2"),
            providerSessionId: ProviderSessionId.make("provider-session-worker-test-2"),
          });
          yield* otherSession.close;
          assert.isFalse(otherSession.isAlive?.());
          assert.isTrue(session.isAlive?.());
          assert.lengthOf(registeredPids, 1);
          assert.deepEqual(unregisteredPids, []);

          const receivedDeltas: Array<string> = [];
          const firstDeltaGate = yield* Deferred.make<void>();
          const startupPhases: Array<string> = [];
          const run = yield* session.send({
            message: "hi",
            onStartupPhase: (phase) => Effect.sync(() => startupPhases.push(phase)),
            onDelta: (update) =>
              Effect.gen(function* () {
                const text = (update as { readonly text?: string }).text ?? "";
                if (text === "early-") {
                  yield* Deferred.succeed(firstDeltaGate, undefined);
                }
                receivedDeltas.push(text);
              }),
          });
          assert.equal(run.runId, "run-worker-1");
          assert.deepEqual(startupPhases, ["plugins"]);
          yield* Deferred.await(firstDeltaGate);

          const steerOutcome = yield* run.steer!("change course");
          assert.equal(steerOutcome, "complete_delivered");

          const result = yield* run.wait;
          assert.equal(result.status, "finished");
          assert.equal(result.result, "early-late");
          assert.deepEqual(receivedDeltas, ["early-", "late"]);

          const [messagesA, messagesB] = yield* Effect.all(
            [session.listMessages, session.listMessages],
            { concurrency: "unbounded" },
          );
          assert.lengthOf(messagesA, 1);
          assert.lengthOf(messagesB, 1);
          const usage = yield* session.readContextUsage!;
          assert.deepEqual(usage, { usedTokens: 120, maxTokens: 1000 });
          assert.isTrue(yield* session.runCheckpointed!("run-worker-1"));
          assert.isFalse(yield* session.runCheckpointed!("other"));
          yield* session.rewindAfterRun!("run-worker-1");
          yield* session.close;
          assert.isFalse(session.isAlive?.());

          assert.deepEqual(unregisteredPids, registeredPids);
          assert.deepEqual(stoppedUnits, ["unit-cursor-sdk"]);
          assert.include(protocolEvents, "agent.open");
          assert.include(protocolEvents, "agent.opened");
          assert.include(protocolEvents, "run.started");
          assert.include(protocolEvents, "interaction.update");
          assert.include(protocolEvents, "run.completed");
          assert.include(protocolEvents, "agent.close");
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live(
    "preserves ConfigurationError classification across IPC and cleans up on open failure",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const scriptPath = yield* writeFakeWorker;
          const executable = yield* HostProcess.ExecutablePath;
          let unregistered = false;

          const runner = yield* CursorAgentSdkProcessRunner.makeCursorAgentSdkProcessRunner({
            resolveLaunch: Effect.succeed({
              command: executable,
              args: [scriptPath],
              env: { FAKE_WORKER_MODE: "config-error" },
              registerProcess: () => () => {
                unregistered = true;
              },
            }),
            protocolLoggerFor: () => undefined,
          });

          const error = yield* Effect.flip(runner.open(openInput));
          assert.isTrue(isCursorSdkError(error.cause, "ConfigurationError"));
          assert.isTrue(
            error.cause instanceof Error &&
              error.cause.message.startsWith("Cannot use this model:"),
          );
          assert.isTrue(unregistered);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("fails run.wait with exit code and stderr when the worker crashes mid-run", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scriptPath = yield* writeFakeWorker;
        const executable = yield* HostProcess.ExecutablePath;
        const unregistered = yield* Deferred.make<void>();

        const runner = yield* CursorAgentSdkProcessRunner.makeCursorAgentSdkProcessRunner({
          resolveLaunch: Effect.succeed({
            command: executable,
            args: [scriptPath],
            env: { FAKE_WORKER_MODE: "crash-mid-run" },
            registerProcess: () => () => {
              Deferred.doneUnsafe(unregistered, Exit.void);
            },
          }),
          protocolLoggerFor: () => undefined,
        });

        const session = yield* runner.open(openInput);
        const run = yield* session.send({ message: "hi" });
        const error = yield* Effect.flip(run.wait);
        const msg = CursorAgentSdk.cursorSdkFailureMessage(error);
        assert.include(msg, "code 17");
        assert.notInclude(msg, "fatal worker boom");
        const diagnostic = error.cause instanceof Error ? error.cause.cause : undefined;
        assert.isTrue(
          diagnostic instanceof Error && diagnostic.message.includes("fatal worker boom"),
        );
        // Dead worker scope tears down immediately instead of waiting for sessions to close.
        yield* Deferred.await(unregistered);
        assert.isFalse(session.isAlive?.());
        yield* session.close;
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live(
    "preserves an already-received runDone when the worker exits while onDelta is running",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const scriptPath = yield* writeFakeWorker;
          const executable = yield* HostProcess.ExecutablePath;
          const workerTerminated = yield* Deferred.make<void>();

          const runner = yield* CursorAgentSdkProcessRunner.makeCursorAgentSdkProcessRunner({
            resolveLaunch: Effect.succeed({
              command: executable,
              args: [scriptPath],
              env: { FAKE_WORKER_MODE: "exit-after-done" },
            }),
            protocolLoggerFor: () => undefined,
            onWorkerTerminated: () => {
              Deferred.doneUnsafe(workerTerminated, Exit.void);
            },
          });

          const session = yield* runner.open(openInput);
          const deltaStarted = yield* Deferred.make<void>();
          const releaseDelta = yield* Deferred.make<void>();
          const run = yield* session.send({
            message: "hi",
            onDelta: (update) =>
              Effect.gen(function* () {
                if ((update as { readonly text?: string }).text === "early-") {
                  yield* Deferred.succeed(deltaStarted, undefined);
                  yield* Deferred.await(releaseDelta);
                }
              }),
          });
          yield* Deferred.await(deltaStarted);
          yield* Deferred.await(workerTerminated);
          yield* Deferred.succeed(releaseDelta, undefined);
          const result = yield* run.wait;
          assert.equal(result.status, "finished");
          assert.equal(result.result, "early-late");
          yield* session.close;
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("cancels a started run when send is interrupted before handing it off", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scriptPath = yield* writeFakeWorker;
        const executable = yield* HostProcess.ExecutablePath;
        const startedLogged = yield* Deferred.make<void>();
        const cancelled = yield* Deferred.make<void>();

        const runner = yield* CursorAgentSdkProcessRunner.makeCursorAgentSdkProcessRunner({
          resolveLaunch: Effect.succeed({
            command: executable,
            args: [scriptPath],
            env: { FAKE_WORKER_MODE: "cancel" },
          }),
          protocolLoggerFor: () => (event) => {
            if (event.payload.type === "run.started") {
              return Deferred.succeed(startedLogged, undefined).pipe(Effect.andThen(Effect.never));
            }
            if (event.payload.type === "run.cancel" && event.direction === "incoming") {
              return Deferred.succeed(cancelled, undefined).pipe(Effect.asVoid);
            }
            return Effect.void;
          },
        });
        const session = yield* runner.open(openInput);
        const sending = yield* Effect.forkChild(session.send({ message: "hi" }));
        yield* Deferred.await(startedLogged);
        yield* Fiber.interrupt(sending);
        yield* Deferred.await(cancelled);
        yield* session.close;
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live(
    "closes the session when send is interrupted after transmission before acknowledgment",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const scriptPath = yield* writeFakeWorker;
          const executable = yield* HostProcess.ExecutablePath;
          const receivedByWorker = yield* Deferred.make<void>();

          const runner = yield* CursorAgentSdkProcessRunner.makeCursorAgentSdkProcessRunner({
            resolveLaunch: Effect.succeed({
              command: executable,
              args: [scriptPath],
              env: { FAKE_WORKER_MODE: "hang-send" },
            }),
            protocolLoggerFor: () => (event) =>
              event.payload.type === "run.started"
                ? Deferred.succeed(receivedByWorker, undefined).pipe(Effect.asVoid)
                : Effect.void,
          });

          const session = yield* runner.open(openInput);
          assert.isTrue(session.isAlive?.());
          const sending = yield* Effect.forkChild(session.send({ message: "hi" }));
          yield* Deferred.await(receivedByWorker);
          yield* Fiber.interrupt(sending);
          assert.isFalse(session.isAlive?.());
          yield* session.close;
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("cancels an interrupted text generation in a worker that other sessions keep alive", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scriptPath = yield* writeFakeWorker;
        const executable = yield* HostProcess.ExecutablePath;
        const received = yield* Deferred.make<void>();
        const cancelled = yield* Deferred.make<void>();

        const runner = yield* CursorAgentSdkProcessRunner.makeCursorAgentSdkProcessRunner({
          resolveLaunch: Effect.succeed({
            command: executable,
            args: [scriptPath],
            env: { FAKE_WORKER_MODE: "hang-text" },
          }),
          protocolLoggerFor: () => (event) =>
            event.payload.type === "run.started"
              ? Deferred.succeed(received, undefined).pipe(Effect.asVoid)
              : event.payload.type === "run.cancel"
                ? Deferred.succeed(cancelled, undefined).pipe(Effect.asVoid)
                : Effect.void,
        });
        const session = yield* runner.open(openInput);
        const generating = yield* Effect.forkChild(
          runner.textGenerate!({
            prompt: "title",
            apiKey: "key",
            model: { id: "default" },
            cwd: "/tmp",
            stateRoot: "/tmp",
          }),
        );
        yield* Deferred.await(received);
        yield* Fiber.interrupt(generating);
        yield* Deferred.await(cancelled);
        assert.isTrue(session.isAlive?.());
        yield* session.close;
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("forwards cancel and runs textGenerate in a disposable child process", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scriptPath = yield* writeFakeWorker;
        const executable = yield* HostProcess.ExecutablePath;

        const cancelRunner = yield* CursorAgentSdkProcessRunner.makeCursorAgentSdkProcessRunner({
          resolveLaunch: Effect.succeed({
            command: executable,
            args: [scriptPath],
            env: { FAKE_WORKER_MODE: "cancel" },
          }),
          protocolLoggerFor: () => undefined,
        });
        const session = yield* cancelRunner.open(openInput);
        const run = yield* session.send({ message: "hi" });
        yield* run.cancel;
        const cancelled = yield* run.wait;
        assert.equal(cancelled.status, "cancelled");
        yield* session.close;

        let textGenUnregistered = false;
        const textGenRunner = yield* CursorAgentSdkProcessRunner.makeCursorAgentSdkProcessRunner({
          resolveLaunch: Effect.succeed({
            command: executable,
            args: [scriptPath],
            env: { FAKE_WORKER_MODE: "rate-limit-text" },
            registerProcess: () => () => {
              textGenUnregistered = true;
            },
          }),
          protocolLoggerFor: () => undefined,
        });
        const textResult = yield* textGenRunner.textGenerate!({
          prompt: "title",
          apiKey: "key",
          model: { id: "default" },
          cwd: "/tmp",
          stateRoot: "/tmp",
        });
        assert.equal(textResult.status, "error");
        assert.isTrue(CursorAgentSdk.isCursorUsageLimitError(textResult.error));
        assert.isTrue(textGenUnregistered);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live(
    "settles active runs on a closed session without disrupting peer sessions on the shared worker",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const scriptPath = yield* writeFakeWorker;
          const executable = yield* HostProcess.ExecutablePath;
          const registeredPids: Array<number> = [];

          const runner = yield* CursorAgentSdkProcessRunner.makeCursorAgentSdkProcessRunner({
            resolveLaunch: Effect.succeed({
              command: executable,
              args: [scriptPath],
              env: { FAKE_WORKER_MODE: "cancel" },
              registerProcess: (pid) => {
                registeredPids.push(pid);
                return () => {};
              },
            }),
            protocolLoggerFor: () => undefined,
          });

          const sessionA = yield* runner.open(openInput);
          const sessionB = yield* runner.open({
            ...openInput,
            threadId: ThreadId.make("thread-worker-test-peer"),
            providerSessionId: ProviderSessionId.make("provider-session-worker-test-peer"),
          });
          assert.lengthOf(registeredPids, 1);

          // Start a run on sessionA that stays pending, then close sessionA while sessionB keeps the worker alive.
          const runA = yield* sessionA.send({ message: "hi" });
          const waitA = yield* Effect.forkChild(Effect.flip(runA.wait));
          yield* sessionA.close;
          const errorA = yield* Fiber.join(waitA);
          assert.include(CursorAgentSdk.cursorSdkFailureMessage(errorA), "closed");
          assert.isFalse(sessionA.isAlive?.());
          assert.isTrue(sessionB.isAlive?.());
          assert.lengthOf(yield* sessionB.listMessages, 1);
          yield* sessionB.close;
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live(
    "forwards background shell events across IPC, routes stop(), and ends orphans on worker crash",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const scriptPath = yield* writeFakeWorker;
          const executable = yield* HostProcess.ExecutablePath;

          const runner = yield* CursorAgentSdkProcessRunner.makeCursorAgentSdkProcessRunner({
            resolveLaunch: Effect.succeed({
              command: executable,
              args: [scriptPath],
              env: { FAKE_WORKER_MODE: "background-shell" },
            }),
            protocolLoggerFor: () => undefined,
          });

          const events: Array<object> = [];
          const startedFirst = yield* Deferred.make<() => void>();
          const bothEnded = yield* Deferred.make<void>();
          let endedCount = 0;

          const session = yield* runner.open(openInput);
          const run = yield* session.send({
            message: "watch it",
            onBackgroundShell: (event) =>
              Effect.gen(function* () {
                if (event.type === "started") {
                  const { stop, ...started } = event;
                  events.push(started);
                  if (event.id === "sh-1") yield* Deferred.succeed(startedFirst, stop);
                  return;
                }
                events.push(event);
                endedCount += 1;
                if (endedCount === 2) yield* Deferred.succeed(bothEnded, undefined);
              }),
          });
          yield* run.wait;

          // Stopping sh-1 triggers a worker-side ended event, then the fake worker crashes to
          // verify sh-2 gets a synthesized ended(stopped: true) event.
          const stopFirst = yield* Deferred.await(startedFirst);
          stopFirst();
          yield* Deferred.await(bothEnded);

          assert.deepEqual(events, [
            { type: "started", id: "sh-1", pid: 4101, command: "sleep 60" },
            { type: "started", id: "sh-2", pid: 4102, command: "tail -f" },
            {
              type: "ended",
              id: "sh-1",
              pid: 4101,
              command: "sleep 60",
              stopped: true,
              exitCode: undefined,
              outputPath: undefined,
            },
            {
              type: "ended",
              id: "sh-2",
              pid: 4102,
              command: "tail -f",
              stopped: true,
              exitCode: undefined,
              outputPath: undefined,
            },
          ]);
          yield* session.close;
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );
});
