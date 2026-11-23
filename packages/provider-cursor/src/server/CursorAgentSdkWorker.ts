import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";

import * as CursorAgentSdk from "./CursorAgentSdk.ts";
import {
  type CursorWorkerMessage,
  type CursorWorkerRequest,
  type SerializedRunnerFailure,
  decodeWorkerFrame,
  encodeWorkerFrame,
  serializeRunResult,
  serializeWorkerError,
} from "./CursorAgentSdkWorkerProtocol.ts";
import * as CursorSdk from "./CursorSdk.ts";
import { runCursorTextGenerationInProcess } from "./textGeneration.ts";

const CLOSE_GRACE = Duration.seconds(3);

function toRunnerFailure(method: string, cause: unknown): SerializedRunnerFailure {
  if (CursorAgentSdk.isCursorAgentSdkRunnerError(cause)) {
    return {
      method: cause.method,
      cause: serializeWorkerError(cause.cause),
    };
  }
  return {
    method,
    cause: serializeWorkerError(cause),
  };
}

function exitFailure(
  method: string,
  exit: Exit.Failure<unknown, unknown>,
): SerializedRunnerFailure {
  const squashed = Cause.squash(exit.cause);
  return toRunnerFailure(method, squashed);
}

/** Runs the Cursor SDK worker loop over Effect's `Stdio` service until `close` or stdin EOF. */
const runCursorSdkWorkerWithStdio = Effect.fn("CursorAgentSdkWorker.run")(function* (options?: {
  readonly shutdownSignal?: Deferred.Deferred<void>;
}) {
  const stdio = yield* Stdio.Stdio;
  const cursorSdk = yield* CursorSdk.CursorSdk;
  const workerScope = yield* Effect.scope;
  const shutdownSignal = options?.shutdownSignal ?? (yield* Deferred.make<void>());
  const outgoing = yield* Queue.unbounded<string, Cause.Done>();

  const writerFiber = yield* Stream.fromQueue(outgoing).pipe(
    Stream.run(stdio.stdout()),
    Effect.ignoreCause,
    Effect.forkScoped,
  );

  const writeMessage = (message: CursorWorkerMessage): void => {
    Queue.offerUnsafe(outgoing, encodeWorkerFrame(message));
  };

  let activeSendStarts = 0;
  // One worker hosts every Cursor session; each session is keyed by its open request id.
  const sessions = new Map<number, CursorAgentSdk.CursorAgentSdkSession>();
  const openingSessionIds = new Set<number>();
  const pendingClosedSessionIds = new Set<number>();
  // Other sessions keep the worker alive, so an abandoned generation must be interrupted here.
  const textGenerations = new Map<number, Fiber.Fiber<unknown, unknown>>();
  const activeRuns = new Map<
    number,
    { readonly sessionId: number; readonly run: CursorAgentSdk.CursorAgentSdkRun }
  >();
  const backgroundShellStops = new Map<string, () => void>();
  const startingSendIds = new Set<number>();
  const pendingCancelledSendIds = new Set<number>();
  const sessionIdByOptions = new WeakMap<object, number>();
  let shuttingDown = false;

  const runner = yield* CursorAgentSdk.makeCursorAgentSdkRunner((input) => {
    const boundSessionId = sessionIdByOptions.get(input.options);
    return (event) =>
      Effect.sync(() => {
        if (activeSendStarts > 0 && event.payload.type === "run.cancel") {
          writeMessage({
            type: "protocolLog",
            providerSessionId: input.providerSessionId,
            ...(boundSessionId === undefined ? {} : { sessionId: boundSessionId }),
            event,
          });
        }
      });
  });

  // Untraced: called from closeSession/close/shutdown handlers that already carry spans.
  const closeSession = Effect.fnUntraced(function* (
    sessionId: number,
  ): Effect.fn.Return<Exit.Exit<void, CursorAgentSdk.CursorAgentSdkRunnerError>> {
    const shellPrefix = `${sessionId}:`;
    for (const key of backgroundShellStops.keys()) {
      if (key.startsWith(shellPrefix)) backgroundShellStops.delete(key);
    }
    if (openingSessionIds.has(sessionId)) {
      pendingClosedSessionIds.add(sessionId);
    }
    const current = sessions.get(sessionId);
    sessions.delete(sessionId);
    for (const [sendId, entry] of activeRuns.entries()) {
      if (entry.sessionId === sessionId) {
        activeRuns.delete(sendId);
      }
    }
    if (current === undefined) {
      return Exit.void;
    }
    const closeExit = yield* Effect.exit(current.close.pipe(Effect.timeoutOption(CLOSE_GRACE)));
    return Exit.isFailure(closeExit) ? closeExit : Exit.void;
  });

  // Untraced: shutdown helper invoked from close request or finalizer.
  const closeAllSessions = Effect.fnUntraced(function* () {
    const ids = Array.from(new Set([...sessions.keys(), ...openingSessionIds]));
    return yield* Effect.forEach(ids, (sessionId) => closeSession(sessionId), {
      concurrency: "unbounded",
    });
  });

  // Untraced: dispatches one decoded worker request; inner runner operations carry spans.
  const handleRequest = Effect.fnUntraced(function* (
    req: CursorWorkerRequest,
  ): Effect.fn.Return<void> {
    if (shuttingDown && req.type !== "close") {
      writeMessage({
        type: "response",
        id: req.id,
        ok: false,
        error: toRunnerFailure(req.type, new Error("Cursor SDK worker is shutting down.")),
      });
      return;
    }

    switch (req.type) {
      case "open": {
        openingSessionIds.add(req.id);
        sessionIdByOptions.set(req.options, req.id);
        const exit = yield* Effect.exit(
          runner.open({
            operation: req.operation,
            ...(req.agentId === undefined ? {} : { agentId: req.agentId }),
            ...(req.storeCwd === undefined ? {} : { storeCwd: req.storeCwd }),
            options: req.options,
            threadId: req.threadId,
            providerSessionId: req.providerSessionId,
          }),
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              openingSessionIds.delete(req.id);
            }),
          ),
        );
        if (Exit.isFailure(exit)) {
          pendingClosedSessionIds.delete(req.id);
          writeMessage({
            type: "response",
            id: req.id,
            ok: false,
            error: exitFailure("open", exit),
          });
          return;
        }
        if (pendingClosedSessionIds.delete(req.id)) {
          yield* exit.value.close.pipe(Effect.timeoutOption(CLOSE_GRACE), Effect.ignore);
          const aborted = Object.assign(new Error("Cursor session was closed while opening."), {
            name: "AbortError",
          });
          writeMessage({
            type: "response",
            id: req.id,
            ok: false,
            error: toRunnerFailure("open", aborted),
          });
          return;
        }
        sessions.set(req.id, exit.value);
        writeMessage({
          type: "response",
          id: req.id,
          ok: true,
          result: { agentId: exit.value.agentId },
        });
        return;
      }

      case "send": {
        const session = sessions.get(req.sessionId);
        if (session === undefined) {
          writeMessage({
            type: "response",
            id: req.id,
            ok: false,
            error: toRunnerFailure("run.start", new Error("Cursor SDK session is not open.")),
          });
          return;
        }
        startingSendIds.add(req.id);
        activeSendStarts += 1;
        const exit = yield* Effect.exit(
          session.send({
            message: req.message,
            ...(req.options === undefined ? {} : { options: req.options }),
            ...(req.summarize === undefined ? {} : { summarize: req.summarize }),
            ...(req.resume === undefined ? {} : { resume: req.resume }),
            onDelta: (update) =>
              Effect.sync(() => {
                if (sessions.has(req.sessionId) && !pendingCancelledSendIds.has(req.id)) {
                  writeMessage({ type: "delta", sendId: req.id, update });
                }
              }),
            onStartupPhase: (phase) =>
              Effect.sync(() => {
                if (startingSendIds.has(req.id)) {
                  writeMessage({ type: "startupPhase", sendId: req.id, phase });
                }
              }),
            ...(req.listenBackgroundShells === true
              ? {
                  onBackgroundShell: (event: CursorAgentSdk.CursorBackgroundShellEvent) =>
                    Effect.sync(() => {
                      const key = `${req.sessionId}:${event.id}`;
                      if (event.type === "started") {
                        backgroundShellStops.set(key, event.stop);
                        writeMessage({
                          type: "backgroundShell",
                          sessionId: req.sessionId,
                          event: {
                            type: "started",
                            id: event.id,
                            pid: event.pid,
                            command: event.command,
                          },
                        });
                        return;
                      }
                      backgroundShellStops.delete(key);
                      writeMessage({
                        type: "backgroundShell",
                        sessionId: req.sessionId,
                        event,
                      });
                    }),
                }
              : {}),
          }),
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              startingSendIds.delete(req.id);
              activeSendStarts -= 1;
            }),
          ),
        );
        if (Exit.isFailure(exit)) {
          pendingCancelledSendIds.delete(req.id);
          writeMessage({
            type: "response",
            id: req.id,
            ok: false,
            error: exitFailure(req.resume === true ? "run.resume" : "run.start", exit),
          });
          return;
        }
        const run = exit.value;
        // Session closed or cancel arrived while send was starting: stop the run immediately.
        if (!sessions.has(req.sessionId) || pendingCancelledSendIds.delete(req.id)) {
          yield* run.cancel.pipe(Effect.timeoutOption(CLOSE_GRACE), Effect.ignore);
          const aborted = Object.assign(new Error("Cursor run was cancelled while starting."), {
            name: "AbortError",
          });
          writeMessage({
            type: "response",
            id: req.id,
            ok: false,
            error: toRunnerFailure(req.resume === true ? "run.resume" : "run.start", aborted),
          });
          return;
        }
        activeRuns.set(req.id, { sessionId: req.sessionId, run });
        writeMessage({
          type: "response",
          id: req.id,
          ok: true,
          result: { runId: run.runId, agentId: run.agentId },
        });
        yield* Effect.exit(run.wait).pipe(
          Effect.tap((waitExit) =>
            Effect.sync(() => {
              activeRuns.delete(req.id);
              if (Exit.isFailure(waitExit)) {
                writeMessage({
                  type: "runDone",
                  sendId: req.id,
                  ok: false,
                  error: exitFailure("run.wait", waitExit),
                });
                return;
              }
              writeMessage({
                type: "runDone",
                sendId: req.id,
                ok: true,
                result: serializeRunResult(waitExit.value),
              });
            }),
          ),
          Effect.asVoid,
          Effect.forkIn(workerScope),
        );
        return;
      }

      case "stopBackgroundShell": {
        const key = `${req.sessionId}:${req.shellId}`;
        const stop = backgroundShellStops.get(key);
        backgroundShellStops.delete(key);
        yield* Effect.try({ try: () => stop?.(), catch: () => undefined }).pipe(Effect.ignore);
        writeMessage({ type: "response", id: req.id, ok: true, result: null });
        return;
      }

      case "steer": {
        const entry = activeRuns.get(req.sendId);
        if (entry?.run.steer === undefined) {
          writeMessage({
            type: "response",
            id: req.id,
            ok: true,
            result: "revert_to_followup",
          });
          return;
        }
        const exit = yield* Effect.exit(entry.run.steer(req.text));
        if (Exit.isFailure(exit)) {
          writeMessage({
            type: "response",
            id: req.id,
            ok: false,
            error: exitFailure("run.steer", exit),
          });
          return;
        }
        writeMessage({ type: "response", id: req.id, ok: true, result: exit.value });
        return;
      }

      case "cancel": {
        const entry = activeRuns.get(req.sendId);
        if (entry === undefined) {
          if (startingSendIds.has(req.sendId)) {
            pendingCancelledSendIds.add(req.sendId);
          }
          writeMessage({ type: "response", id: req.id, ok: true, result: null });
          return;
        }
        const exit = yield* Effect.exit(entry.run.cancel);
        if (Exit.isFailure(exit)) {
          writeMessage({
            type: "response",
            id: req.id,
            ok: false,
            error: exitFailure("run.cancel", exit),
          });
          return;
        }
        writeMessage({ type: "response", id: req.id, ok: true, result: null });
        return;
      }

      case "listMessages": {
        const session = sessions.get(req.sessionId);
        if (session === undefined) {
          writeMessage({
            type: "response",
            id: req.id,
            ok: false,
            error: toRunnerFailure(
              "agent.messages.list",
              new Error("Cursor SDK session is not open."),
            ),
          });
          return;
        }
        const exit = yield* Effect.exit(session.listMessages);
        if (Exit.isFailure(exit)) {
          writeMessage({
            type: "response",
            id: req.id,
            ok: false,
            error: exitFailure("agent.messages.list", exit),
          });
          return;
        }
        writeMessage({ type: "response", id: req.id, ok: true, result: exit.value });
        return;
      }

      case "readContextUsage": {
        const session = sessions.get(req.sessionId);
        if (session?.readContextUsage === undefined) {
          writeMessage({ type: "response", id: req.id, ok: true, result: null });
          return;
        }
        const exit = yield* Effect.exit(session.readContextUsage);
        if (Exit.isFailure(exit)) {
          writeMessage({
            type: "response",
            id: req.id,
            ok: false,
            error: exitFailure("agent.checkpoint.load", exit),
          });
          return;
        }
        writeMessage({ type: "response", id: req.id, ok: true, result: exit.value ?? null });
        return;
      }

      case "runCheckpointed": {
        const session = sessions.get(req.sessionId);
        if (session?.runCheckpointed === undefined) {
          writeMessage({ type: "response", id: req.id, ok: true, result: false });
          return;
        }
        const exit = yield* Effect.exit(session.runCheckpointed(req.runId));
        if (Exit.isFailure(exit)) {
          writeMessage({
            type: "response",
            id: req.id,
            ok: false,
            error: exitFailure("agent.run.get", exit),
          });
          return;
        }
        writeMessage({ type: "response", id: req.id, ok: true, result: exit.value });
        return;
      }

      case "rewindAfterRun": {
        const session = sessions.get(req.sessionId);
        if (session?.rewindAfterRun === undefined) {
          writeMessage({ type: "response", id: req.id, ok: true, result: null });
          return;
        }
        const exit = yield* Effect.exit(session.rewindAfterRun(req.runId));
        if (Exit.isFailure(exit)) {
          writeMessage({
            type: "response",
            id: req.id,
            ok: false,
            error: exitFailure("agent.rewind", exit),
          });
          return;
        }
        writeMessage({ type: "response", id: req.id, ok: true, result: null });
        return;
      }

      case "textGenerate": {
        const fiber = yield* Effect.forkIn(
          runCursorTextGenerationInProcess(req).pipe(
            Effect.provideService(CursorSdk.CursorSdk, cursorSdk),
          ),
          workerScope,
        );
        textGenerations.set(req.id, fiber);
        const exit = yield* Fiber.await(fiber).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              textGenerations.delete(req.id);
            }),
          ),
        );
        if (Exit.isFailure(exit)) {
          writeMessage({
            type: "response",
            id: req.id,
            ok: false,
            error: exitFailure("textGenerate", exit),
          });
          return;
        }
        writeMessage({
          type: "response",
          id: req.id,
          ok: true,
          result: serializeRunResult(exit.value),
        });
        return;
      }

      case "cancelTextGenerate": {
        const fiber = textGenerations.get(req.textGenerateId);
        if (fiber !== undefined) {
          yield* Effect.forkIn(Fiber.interrupt(fiber), workerScope);
        }
        writeMessage({ type: "response", id: req.id, ok: true, result: null });
        return;
      }

      case "closeSession": {
        const exit = yield* closeSession(req.sessionId);
        writeMessage(
          Exit.isFailure(exit)
            ? { type: "response", id: req.id, ok: false, error: exitFailure("agent.close", exit) }
            : { type: "response", id: req.id, ok: true, result: null },
        );
        return;
      }

      case "close": {
        shuttingDown = true;
        const exits = yield* closeAllSessions();
        const exit = exits.find(Exit.isFailure) ?? Exit.void;
        if (Exit.isFailure(exit)) {
          writeMessage({
            type: "response",
            id: req.id,
            ok: false,
            error: exitFailure("agent.close", exit),
          });
        } else {
          writeMessage({ type: "response", id: req.id, ok: true, result: null });
        }
        yield* Deferred.succeed(shutdownSignal, undefined);
        return;
      }
    }
  });

  const dispatchLine = (line: string): Effect.Effect<void> => {
    if (line.trim().length === 0) return Effect.void;
    let parsed: CursorWorkerRequest;
    try {
      parsed = decodeWorkerFrame(line) as CursorWorkerRequest;
    } catch (cause) {
      return Effect.logWarning("Invalid Cursor SDK worker frame.", { cause });
    }
    return handleRequest(parsed).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          writeMessage({
            type: "response",
            id: parsed.id,
            ok: false,
            error: toRunnerFailure(parsed.type, Cause.squash(cause)),
          });
        }),
      ),
      Effect.forkIn(workerScope),
      Effect.asVoid,
    );
  };

  yield* stdio.stdin.pipe(
    Stream.interruptWhen(Deferred.await(shutdownSignal)),
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach(dispatchLine),
    Effect.ignoreCause,
  );

  shuttingDown = true;
  yield* Effect.forEach(Array.from(textGenerations.values()), (fiber) => Fiber.interrupt(fiber), {
    concurrency: "unbounded",
    discard: true,
  });
  yield* closeAllSessions().pipe(Effect.ignore);
  yield* Queue.end(outgoing);
  yield* Fiber.await(writerFiber).pipe(Effect.timeoutOption(CLOSE_GRACE), Effect.ignore);
});

export async function runCursorSdkWorker(
  platformLayer: Layer.Layer<FileSystem.FileSystem | Path.Path | Stdio.Stdio>,
): Promise<void> {
  // Electron has already booted in Node mode; strip the flag so agent shells do not inherit it.
  delete process.env.ELECTRON_RUN_AS_NODE;

  // Reserve fd 1 exclusively for NDJSON frames; redirect stray SDK logs to stderr.
  const rawStdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.on("error", () => {});
  process.stderr.on("error", () => {});
  process.stdout.write = stderrWrite as typeof process.stdout.write;
  console.log = console.info = console.debug = console.warn = console.error;

  const rawStdoutSink = Sink.forEach((chunk: string | Uint8Array) =>
    Effect.callback<void>((resume) => {
      try {
        rawStdoutWrite(chunk, () => resume(Effect.void));
      } catch {
        resume(Effect.void);
      }
    }),
  );

  const workerStdioLayer = Layer.effect(
    Stdio.Stdio,
    Effect.map(Stdio.Stdio, (baseStdio) =>
      Stdio.make({
        args: baseStdio.args,
        stdin: baseStdio.stdin,
        stdout: () => rawStdoutSink,
        stderr: baseStdio.stderr,
      }),
    ),
  );

  const program = Effect.scoped(
    Effect.gen(function* () {
      const shutdownSignal = yield* Deferred.make<void>();
      const onSignal = () => {
        Deferred.doneUnsafe(shutdownSignal, Exit.void);
      };
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          process.on("SIGTERM", onSignal);
          process.on("SIGINT", onSignal);
        }),
        () =>
          Effect.sync(() => {
            process.off("SIGTERM", onSignal);
            process.off("SIGINT", onSignal);
          }),
      );
      yield* runCursorSdkWorkerWithStdio({ shutdownSignal });
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(CursorSdk.layer, workerStdioLayer).pipe(Layer.provideMerge(platformLayer)),
    ),
  );

  await Effect.runPromise(program);
  // SDK keep-alive handles can outlive session disposal; exit explicitly once stdout has flushed.
  process.exit(0);
}
