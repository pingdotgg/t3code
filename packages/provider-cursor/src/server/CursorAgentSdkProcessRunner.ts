import type { AgentMessage, InteractionUpdate, RunResult, SteerAckOutcome } from "@cursor/sdk";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import { AgentScope } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as CursorAgentSdk from "./CursorAgentSdk.ts";
import {
  type CursorWorkerMessage,
  type CursorWorkerRequest,
  type CursorWorkerResponsePayload,
  type SerializedRunResult,
  type SerializedRunnerFailure,
  decodeWorkerFrame,
  deserializeRunResult,
  deserializeWorkerError,
  encodeWorkerFrame,
} from "./CursorAgentSdkWorkerProtocol.ts";

const WORKER_CLOSE_TIMEOUT = Duration.seconds(3);
const WORKER_EXIT_TIMEOUT = Duration.seconds(2);
const MAX_STDERR_CHARS = 8_192;

export interface CursorSdkWorkerLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly registerProcess?: ((pid: number) => () => void) | undefined;
}

type RunQueueItem =
  | { readonly _tag: "delta"; readonly update: InteractionUpdate }
  | { readonly _tag: "done"; readonly ok: true; readonly result: RunResult }
  | {
      readonly _tag: "done";
      readonly ok: false;
      readonly error: CursorAgentSdk.CursorAgentSdkRunnerError;
    };

interface ActiveWorkerRun {
  readonly queue: Queue.Queue<RunQueueItem>;
  readonly waitDeferred: Deferred.Deferred<RunResult, CursorAgentSdk.CursorAgentSdkRunnerError>;
  doneEnqueued: boolean;
}

function toRunnerError(method: string, cause: unknown): CursorAgentSdk.CursorAgentSdkRunnerError {
  return CursorAgentSdk.isCursorAgentSdkRunnerError(cause)
    ? cause
    : new CursorAgentSdk.CursorAgentSdkRunnerError({ method, cause });
}

function fromSerializedFailure(
  failure: SerializedRunnerFailure,
): CursorAgentSdk.CursorAgentSdkRunnerError {
  return new CursorAgentSdk.CursorAgentSdkRunnerError({
    method: failure.method,
    cause: deserializeWorkerError(failure.cause),
  });
}

function workerExitError(method: string, exitCode: number | undefined, stderr: string) {
  const trimmedStderr = stderr.trim();
  const detail =
    trimmedStderr.length > 0
      ? `Cursor SDK worker exited unexpectedly${exitCode === undefined ? "" : ` (code ${exitCode})`}: ${trimmedStderr}`
      : `Cursor SDK worker exited unexpectedly${exitCode === undefined ? "" : ` (code ${exitCode})`}.`;
  return new CursorAgentSdk.CursorAgentSdkRunnerError({
    method,
    cause: new Error(detail),
  });
}

interface SpawnedCursorWorker {
  readonly scope: Scope.Scope;
  readonly nextId: () => number;
  readonly requestWithId: (
    id: number,
    frame: CursorWorkerRequest,
    method: string,
  ) => Effect.Effect<CursorWorkerResponsePayload, CursorAgentSdk.CursorAgentSdkRunnerError>;
  readonly request: (
    build: (id: number) => CursorWorkerRequest,
    method: string,
  ) => Effect.Effect<CursorWorkerResponsePayload, CursorAgentSdk.CursorAgentSdkRunnerError>;
  readonly registerRun: (sendId: number) => Effect.Effect<ActiveWorkerRun>;
  readonly unregisterRun: (sendId: number) => void;
  readonly close: (graceful: boolean) => Effect.Effect<void>;
}

export const makeCursorAgentSdkProcessRunner = Effect.fn("makeCursorAgentSdkProcessRunner")(
  function* (options: {
    readonly resolveLaunch: Effect.Effect<CursorSdkWorkerLaunch>;
    readonly protocolLoggerFor: (
      input: CursorAgentSdk.CursorAgentSdkOpenInput,
    ) => CursorAgentSdk.CursorAgentSdkProtocolLogger | undefined;
  }) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const agentScope = yield* AgentScope;
    const hostEnvironment = yield* HostProcess.Environment;
    const activeScopes = new Set<Scope.Closeable>();

    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        Array.from(activeScopes),
        (scope) => Scope.close(scope, Exit.void).pipe(Effect.ignore),
        { concurrency: "unbounded", discard: true },
      ),
    );

    const spawnWorker = Effect.fn("CursorAgentSdkProcessRunner.spawnWorker")(function* (input: {
      readonly name: string;
      readonly threadId?: string | undefined;
      readonly onProtocolLog?: (
        event: CursorAgentSdk.CursorAgentSdkProtocolLogEvent,
      ) => Effect.Effect<void>;
    }): Effect.fn.Return<SpawnedCursorWorker, CursorAgentSdk.CursorAgentSdkRunnerError> {
      const workerScope = yield* Scope.make();
      activeScopes.add(workerScope);

      const teardownScope = () => {
        activeScopes.delete(workerScope);
        return Scope.close(workerScope, Exit.void).pipe(Effect.ignore);
      };

      const launch = yield* options.resolveLaunch.pipe(
        Effect.onError(() => teardownScope()),
        Effect.mapError((cause) => toRunnerError("worker.launch", cause)),
      );
      const env: NodeJS.ProcessEnv = {
        ...hostEnvironment,
        ...launch.env,
        ELECTRON_RUN_AS_NODE: "1",
      };
      const wrapped = yield* agentScope.wrap({
        command: launch.command,
        args: launch.args,
        name: input.name,
        ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
        env,
      });

      const handle = yield* Scope.provide(
        Effect.acquireRelease(
          spawner.spawn(
            ChildProcess.make(wrapped.command, wrapped.args, {
              stdin: { stream: "pipe", endOnDone: false },
              stdout: "pipe",
              stderr: "pipe",
              env,
              killSignal: "SIGTERM",
              forceKillAfter: WORKER_EXIT_TIMEOUT,
            }),
          ),
          (child) =>
            child
              .kill()
              .pipe(
                Effect.ignore,
                Effect.andThen(
                  wrapped.unit === undefined ? Effect.void : agentScope.stop(wrapped.unit),
                ),
              ),
        ),
        workerScope,
      ).pipe(
        Effect.onError(() => teardownScope()),
        Effect.mapError((cause) => toRunnerError("worker.spawn", cause)),
      );

      if (launch.registerProcess !== undefined) {
        const unregister = yield* Effect.try({
          try: () => launch.registerProcess!(handle.pid),
          catch: (cause) => toRunnerError("worker.register", cause),
        }).pipe(Effect.onError(() => teardownScope()));
        yield* Scope.addFinalizer(workerScope, Effect.sync(unregister));
      }

      const writeMutex = yield* Semaphore.make(1);
      const closed = yield* Ref.make(false);
      const closedDone = yield* Deferred.make<void>();
      const stdoutDone = yield* Deferred.make<void>();
      const stderrDone = yield* Deferred.make<void>();
      let nextRequestId = 0;
      let stderrTail = "";
      let terminated: { readonly exitCode: number | undefined } | undefined;

      const pendingRequests = new Map<
        number,
        {
          readonly method: string;
          readonly deferred: Deferred.Deferred<
            CursorWorkerResponsePayload,
            CursorAgentSdk.CursorAgentSdkRunnerError
          >;
        }
      >();
      const activeRuns = new Map<number, ActiveWorkerRun>();

      // Untraced: internal shutdown helper already covered by the enclosing operation span.
      const failAllPending = Effect.fnUntraced(function* (
        exitCode: number | undefined,
        forceActiveRuns: boolean,
      ) {
        if (terminated === undefined) {
          terminated = { exitCode };
        }
        const pending = Array.from(pendingRequests.entries());
        pendingRequests.clear();
        for (const [, entry] of pending) {
          yield* Deferred.fail(entry.deferred, workerExitError(entry.method, exitCode, stderrTail));
        }
        for (const run of activeRuns.values()) {
          const error = workerExitError("run.wait", exitCode, stderrTail);
          if (!run.doneEnqueued) {
            run.doneEnqueued = true;
            Queue.offerUnsafe(run.queue, { _tag: "done", ok: false, error });
            yield* Deferred.fail(run.waitDeferred, error);
          } else if (forceActiveRuns) {
            // Forced teardown interrupts the FIFO consumer, so settle waiters directly.
            yield* Deferred.fail(run.waitDeferred, error);
          }
        }
      });

      const handleLine = (line: string): Effect.Effect<void> => {
        if (line.trim().length === 0) return Effect.void;
        let parsed: CursorWorkerMessage;
        try {
          parsed = decodeWorkerFrame(line) as CursorWorkerMessage;
        } catch {
          return Effect.void;
        }
        switch (parsed.type) {
          case "response": {
            const entry = pendingRequests.get(parsed.id);
            if (entry === undefined) return Effect.void;
            pendingRequests.delete(parsed.id);
            return parsed.ok
              ? Deferred.succeed(entry.deferred, parsed.result).pipe(Effect.asVoid)
              : Deferred.fail(entry.deferred, fromSerializedFailure(parsed.error)).pipe(
                  Effect.asVoid,
                );
          }
          case "delta": {
            const run = activeRuns.get(parsed.sendId);
            if (run !== undefined && !run.doneEnqueued) {
              Queue.offerUnsafe(run.queue, { _tag: "delta", update: parsed.update });
            }
            return Effect.void;
          }
          case "runDone": {
            const run = activeRuns.get(parsed.sendId);
            if (run !== undefined && !run.doneEnqueued) {
              run.doneEnqueued = true;
              Queue.offerUnsafe(
                run.queue,
                parsed.ok
                  ? { _tag: "done", ok: true, result: deserializeRunResult(parsed.result) }
                  : { _tag: "done", ok: false, error: fromSerializedFailure(parsed.error) },
              );
            }
            return Effect.void;
          }
          case "protocolLog":
            return input.onProtocolLog === undefined
              ? Effect.void
              : input.onProtocolLog(parsed.event).pipe(Effect.ignore);
        }
      };

      yield* handle.stderr.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) =>
          Effect.sync(() => {
            stderrTail += chunk;
            if (stderrTail.length > MAX_STDERR_CHARS) {
              stderrTail = stderrTail.slice(-MAX_STDERR_CHARS);
            }
          }),
        ),
        Effect.ignore,
        Effect.ensuring(Deferred.succeed(stderrDone, undefined).pipe(Effect.asVoid)),
        Effect.forkIn(workerScope),
      );

      yield* handle.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach(handleLine),
        Effect.ignore,
        Effect.ensuring(
          Deferred.succeed(stdoutDone, undefined).pipe(
            Effect.andThen(
              Effect.suspend(() => {
                if (terminated !== undefined) return Effect.void;
                return handle.exitCode.pipe(
                  Effect.map((code) => Number(code)),
                  Effect.timeoutOption(Duration.millis(250)),
                  Effect.orElseSucceed(() => Option.none<number>()),
                  Effect.flatMap((exitCode) =>
                    failAllPending(Option.getOrUndefined(exitCode), false),
                  ),
                );
              }),
            ),
          ),
        ),
        Effect.forkIn(workerScope),
      );

      yield* handle.exitCode.pipe(
        Effect.map((code) => Number(code)),
        Effect.orElseSucceed(() => undefined),
        Effect.flatMap((exitCode) =>
          // Drain buffered stdout replies and stderr tail before failing remaining requests.
          Effect.all([Deferred.await(stdoutDone), Deferred.await(stderrDone)], {
            concurrency: "unbounded",
            discard: true,
          }).pipe(
            Effect.timeoutOption(Duration.millis(500)),
            Effect.andThen(failAllPending(exitCode, false)),
          ),
        ),
        Effect.forkIn(workerScope),
      );

      const writeFrame = (frame: CursorWorkerRequest, method: string) =>
        writeMutex.withPermits(1)(
          Stream.run(Stream.encodeText(Stream.make(encodeWorkerFrame(frame))), handle.stdin).pipe(
            Effect.mapError((cause) => toRunnerError(method, cause)),
          ),
        );

      // Untraced: callers own the enclosing RPC operation span.
      const requestWithId = Effect.fnUntraced(function* (
        id: number,
        frame: CursorWorkerRequest,
        method: string,
      ) {
        if (terminated !== undefined) {
          return yield* workerExitError(method, terminated.exitCode, stderrTail);
        }
        const deferred = yield* Deferred.make<
          CursorWorkerResponsePayload,
          CursorAgentSdk.CursorAgentSdkRunnerError
        >();
        pendingRequests.set(id, { method, deferred });
        return yield* writeFrame(frame, method).pipe(
          Effect.andThen(Deferred.await(deferred)),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              pendingRequests.delete(id);
            }),
          ),
          Effect.onError(() =>
            Effect.sync(() => {
              pendingRequests.delete(id);
            }),
          ),
        );
      });

      const nextId = () => ++nextRequestId;

      const request = (
        build: (id: number) => CursorWorkerRequest,
        method: string,
      ): Effect.Effect<CursorWorkerResponsePayload, CursorAgentSdk.CursorAgentSdkRunnerError> =>
        Effect.suspend(() => {
          const id = nextId();
          return requestWithId(id, build(id), method);
        });

      // Untraced: called from close/finalizer boundaries that already hold a span.
      const close = Effect.fnUntraced(function* (graceful: boolean) {
        if (yield* Ref.getAndSet(closed, true)) {
          return yield* Deferred.await(closedDone);
        }
        const gracefulShutdown =
          graceful && terminated === undefined
            ? request((id) => ({ id, type: "close" }), "agent.close").pipe(
                Effect.timeoutOption(WORKER_CLOSE_TIMEOUT),
                Effect.ignore,
                Effect.andThen(
                  handle.exitCode.pipe(Effect.timeoutOption(WORKER_EXIT_TIMEOUT), Effect.ignore),
                ),
              )
            : Effect.void;
        yield* gracefulShutdown.pipe(
          Effect.ensuring(
            failAllPending(terminated?.exitCode, true).pipe(
              Effect.andThen(teardownScope()),
              Effect.ensuring(Deferred.succeed(closedDone, undefined).pipe(Effect.asVoid)),
            ),
          ),
        );
      });

      // Untraced: per-send registration inside CursorAgentSdkSession.send.
      const registerRun = Effect.fnUntraced(function* (sendId: number) {
        const queue = yield* Queue.unbounded<RunQueueItem>();
        const waitDeferred = yield* Deferred.make<
          RunResult,
          CursorAgentSdk.CursorAgentSdkRunnerError
        >();
        const state: ActiveWorkerRun = { queue, waitDeferred, doneEnqueued: false };
        activeRuns.set(sendId, state);
        return state;
      });

      return {
        scope: workerScope,
        nextId,
        requestWithId,
        request,
        registerRun,
        unregisterRun: (sendId) => {
          activeRuns.delete(sendId);
        },
        close,
      };
    });

    return CursorAgentSdk.CursorAgentSdkRunner.of({
      open: Effect.fn("CursorAgentSdkProcessRunner.open")(function* (input) {
        const protocolLogger = options.protocolLoggerFor(input);
        const log = (event: CursorAgentSdk.CursorAgentSdkProtocolLogEvent) =>
          protocolLogger === undefined ? Effect.void : protocolLogger(event);

        yield* log({
          direction: "outgoing",
          stage: "decoded",
          payload: {
            type: "agent.open",
            operation: input.operation,
            ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
            options: CursorAgentSdk.loggedCursorAgentOptions(input.options),
          },
        });

        const worker = yield* spawnWorker({
          name: "cursor-sdk",
          threadId: input.threadId,
          ...(protocolLogger === undefined ? {} : { onProtocolLog: protocolLogger }),
        });

        let handedOff = false;
        return yield* Effect.gen(function* () {
          const opened = (yield* worker.request(
            (id) => ({
              id,
              type: "open",
              operation: input.operation,
              ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
              ...(input.storeCwd === undefined ? {} : { storeCwd: input.storeCwd }),
              options: input.options,
              threadId: input.threadId,
              providerSessionId: input.providerSessionId,
            }),
            `agent.${input.operation}`,
          )) as { readonly agentId: string };

          const agentId = opened.agentId;
          yield* log({
            direction: "incoming",
            stage: "decoded",
            payload: {
              type: "agent.opened",
              agentId,
            },
          });

          const closeSession = yield* Effect.cached(
            log({
              direction: "outgoing",
              stage: "decoded",
              payload: {
                type: "agent.close",
                agentId,
              },
            }).pipe(Effect.andThen(worker.close(true))),
          );

          const session = {
            agentId,
            send: Effect.fn("CursorAgentSdkSession.send")(function* (sendInput) {
              const loggedOptions = CursorAgentSdk.loggedCursorSendOptions(sendInput.options);
              yield* sendInput.resume === true
                ? log({
                    direction: "outgoing",
                    stage: "decoded",
                    payload: { type: "run.resume", options: loggedOptions },
                  })
                : log({
                    direction: "outgoing",
                    stage: "decoded",
                    payload: {
                      type: "run.start",
                      message: sendInput.message,
                      options: loggedOptions,
                    },
                  });

              const sendId = worker.nextId();
              const runState = yield* worker.registerRun(sendId);
              const started = (yield* worker
                .requestWithId(
                  sendId,
                  {
                    id: sendId,
                    type: "send",
                    message: sendInput.message,
                    ...(sendInput.options === undefined ? {} : { options: sendInput.options }),
                    ...(sendInput.summarize === undefined
                      ? {}
                      : { summarize: sendInput.summarize }),
                    ...(sendInput.resume === undefined ? {} : { resume: sendInput.resume }),
                  },
                  sendInput.resume === true ? "run.resume" : "run.start",
                )
                .pipe(
                  Effect.onError(() => Effect.sync(() => worker.unregisterRun(sendId))),
                  Effect.onInterrupt(() => Effect.sync(() => worker.unregisterRun(sendId))),
                )) as { readonly runId: string; readonly agentId: string };

              const { runId } = started;
              yield* log({
                direction: "incoming",
                stage: "decoded",
                payload: {
                  type: "run.started",
                  runId,
                  agentId: started.agentId,
                },
              });

              // Consume deltas and terminal completion sequentially from one FIFO queue so every
              // preceding onDelta finishes before run.wait resolves, matching the in-process runner.
              yield* Effect.gen(function* () {
                let callbackFailure: { readonly cause: unknown } | undefined;
                while (true) {
                  const item = yield* Queue.take(runState.queue);
                  if (item._tag === "delta") {
                    if (callbackFailure !== undefined) continue;
                    const deltaExit = yield* Effect.exit(
                      log({
                        direction: "incoming",
                        stage: "decoded",
                        payload: {
                          type: "interaction.update",
                          runId,
                          update: item.update,
                        },
                      }).pipe(Effect.andThen(sendInput.onDelta?.(item.update) ?? Effect.void)),
                    );
                    if (Exit.isFailure(deltaExit)) {
                      callbackFailure = { cause: Cause.squash(deltaExit.cause) };
                    }
                    continue;
                  }
                  if (!item.ok) {
                    yield* Deferred.fail(runState.waitDeferred, item.error);
                    return;
                  }
                  if (callbackFailure !== undefined) {
                    yield* Deferred.fail(
                      runState.waitDeferred,
                      toRunnerError("run.wait", callbackFailure.cause),
                    );
                    return;
                  }
                  yield* log({
                    direction: "incoming",
                    stage: "decoded",
                    payload: {
                      type: "run.completed",
                      result: item.result,
                    },
                  });
                  yield* Deferred.succeed(runState.waitDeferred, item.result);
                  return;
                }
              }).pipe(
                Effect.ensuring(Effect.sync(() => worker.unregisterRun(sendId))),
                Effect.forkIn(worker.scope),
              );

              return {
                runId,
                agentId: started.agentId,
                wait: Deferred.await(runState.waitDeferred),
                steer: Effect.fn("CursorAgentSdkRun.steer")((text: string) =>
                  log({
                    direction: "outgoing",
                    stage: "decoded",
                    payload: {
                      type: "run.steer",
                      runId,
                      text,
                    },
                  }).pipe(
                    Effect.andThen(
                      worker.request(
                        (id) => ({ id, type: "steer", sendId, text }),
                        "run.steer",
                      ) as Effect.Effect<SteerAckOutcome, CursorAgentSdk.CursorAgentSdkRunnerError>,
                    ),
                    Effect.tap((outcome) =>
                      log({
                        direction: "incoming",
                        stage: "decoded",
                        payload: {
                          type: "run.steered",
                          runId,
                          outcome,
                        },
                      }),
                    ),
                  ),
                ),
                cancel: log({
                  direction: "outgoing",
                  stage: "decoded",
                  payload: {
                    type: "run.cancel",
                    runId,
                  },
                }).pipe(
                  Effect.andThen(
                    worker.request((id) => ({ id, type: "cancel", sendId }), "run.cancel"),
                  ),
                  Effect.asVoid,
                ),
              } satisfies CursorAgentSdk.CursorAgentSdkRun;
            }),
            listMessages: log({
              direction: "outgoing",
              stage: "decoded",
              payload: {
                type: "agent.messages.list",
                agentId,
              },
            }).pipe(
              Effect.andThen(
                worker.request(
                  (id) => ({ id, type: "listMessages" }),
                  "agent.messages.list",
                ) as Effect.Effect<
                  ReadonlyArray<AgentMessage>,
                  CursorAgentSdk.CursorAgentSdkRunnerError
                >,
              ),
              Effect.tap((messages) =>
                log({
                  direction: "incoming",
                  stage: "decoded",
                  payload: {
                    type: "agent.messages",
                    agentId,
                    messages,
                  },
                }),
              ),
            ),
            readContextUsage: worker
              .request((id) => ({ id, type: "readContextUsage" }), "agent.checkpoint.load")
              .pipe(
                Effect.map((result) =>
                  result === null ? undefined : (result as CursorAgentSdk.CursorContextUsage),
                ),
              ),
            runCheckpointed: (runId) =>
              worker
                .request(
                  (id) => ({
                    id,
                    type: "runCheckpointed",
                    ...(runId === undefined ? {} : { runId }),
                  }),
                  "agent.run.get",
                )
                .pipe(Effect.map((result) => result === true)),
            rewindAfterRun: (runId) =>
              log({
                direction: "outgoing",
                stage: "decoded",
                payload: { type: "agent.rewind", agentId, afterRunId: runId },
              }).pipe(
                Effect.andThen(
                  worker.request((id) => ({ id, type: "rewindAfterRun", runId }), "agent.rewind"),
                ),
                Effect.asVoid,
              ),
            close: closeSession,
          } satisfies CursorAgentSdk.CursorAgentSdkSession;
          handedOff = true;
          return session;
        }).pipe(
          Effect.ensuring(Effect.suspend(() => (handedOff ? Effect.void : worker.close(false)))),
        );
      }),
      textGenerate: Effect.fn("CursorAgentSdkProcessRunner.textGenerate")(function* (input) {
        const worker = yield* spawnWorker({ name: "cursor-text-gen" });
        return yield* worker
          .request(
            (id) => ({
              id,
              type: "textGenerate",
              prompt: input.prompt,
              apiKey: input.apiKey,
              model: input.model,
              cwd: input.cwd,
              stateRoot: input.stateRoot,
            }),
            "textGenerate",
          )
          .pipe(
            Effect.map((result) => deserializeRunResult(result as SerializedRunResult)),
            Effect.ensuring(worker.close(false)),
          );
      }),
      assertComplete: Effect.void,
    });
  },
);

export const layer = (resolveLaunch: Effect.Effect<CursorSdkWorkerLaunch>) =>
  Layer.effect(
    CursorAgentSdk.CursorAgentSdkRunner,
    Effect.gen(function* () {
      const { native: nativeEventLogger } = yield* ProviderEventLoggers.ProviderEventLoggers;
      return yield* makeCursorAgentSdkProcessRunner({
        resolveLaunch,
        protocolLoggerFor: (input) =>
          CursorAgentSdk.makeCursorAgentSdkProtocolLogger({
            nativeEventLogger,
            threadId: input.threadId,
            providerSessionId: input.providerSessionId,
          }),
      });
    }),
  );
