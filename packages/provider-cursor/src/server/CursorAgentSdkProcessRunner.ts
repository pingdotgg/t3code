import type { AgentMessage, InteractionUpdate, RunResult, SteerAckOutcome } from "@cursor/sdk";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import { AgentScope } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
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
  readonly sessionId: number;
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
  const detail = `Cursor SDK worker exited unexpectedly${exitCode === undefined ? "" : ` (code ${exitCode})`}.`;
  return new CursorAgentSdk.CursorAgentSdkRunnerError({
    method,
    cause: new Error(
      detail,
      trimmedStderr.length > 0 ? { cause: new Error(trimmedStderr) } : undefined,
    ),
  });
}

interface SpawnedCursorWorker {
  readonly scope: Scope.Scope;
  /** Routes worker-side protocol logs to the session that produced them. */
  readonly protocolLoggers: Map<string, CursorAgentSdk.CursorAgentSdkProtocolLogger>;
  readonly sessionProtocolLoggers: Map<number, CursorAgentSdk.CursorAgentSdkProtocolLogger>;
  readonly nextId: () => number;
  readonly requestWithId: (
    id: number,
    frame: CursorWorkerRequest,
    method: string,
    callbacks?: {
      readonly onTransmitting?: () => void;
      readonly onWorkerRejected?: () => void;
    },
  ) => Effect.Effect<CursorWorkerResponsePayload, CursorAgentSdk.CursorAgentSdkRunnerError>;
  readonly request: (
    build: (id: number) => CursorWorkerRequest,
    method: string,
  ) => Effect.Effect<CursorWorkerResponsePayload, CursorAgentSdk.CursorAgentSdkRunnerError>;
  readonly registerRun: (sessionId: number, sendId: number) => Effect.Effect<ActiveWorkerRun>;
  readonly unregisterRun: (sendId: number) => Effect.Effect<void>;
  readonly failSessionRuns: (sessionId: number) => Effect.Effect<void>;
  readonly setBackgroundShellListener: (
    sessionId: number,
    listener: (event: CursorAgentSdk.CursorBackgroundShellEvent) => Effect.Effect<void>,
  ) => Effect.Effect<void>;
  readonly drainBackgroundShellStops: (sessionId: number) => Effect.Effect<void>;
  readonly closeBackgroundShellSession: (sessionId: number) => void;
  readonly isAlive: () => boolean;
  readonly close: (graceful: boolean) => Effect.Effect<void>;
}

export const makeCursorAgentSdkProcessRunner = Effect.fn("makeCursorAgentSdkProcessRunner")(
  function* (options: {
    readonly resolveLaunch: Effect.Effect<CursorSdkWorkerLaunch>;
    readonly protocolLoggerFor: (
      input: CursorAgentSdk.CursorAgentSdkOpenInput,
    ) => CursorAgentSdk.CursorAgentSdkProtocolLogger | undefined;
    readonly onWorkerTerminated?: (exitCode: number | undefined) => void;
  }) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const agentScope = yield* AgentScope;
    const hostEnvironment = yield* HostProcess.Environment;
    const runnerContext = yield* Effect.context<never>();
    const activeCleanups = new Set<Effect.Effect<void>>();

    yield* Effect.addFinalizer(() =>
      Effect.forEach(Array.from(activeCleanups), (cleanup) => cleanup.pipe(Effect.ignore), {
        concurrency: "unbounded",
        discard: true,
      }),
    );

    const spawnWorker = Effect.fn("CursorAgentSdkProcessRunner.spawnWorker")(
      function* (): Effect.fn.Return<
        SpawnedCursorWorker,
        CursorAgentSdk.CursorAgentSdkRunnerError
      > {
        const workerScope = yield* Scope.make();
        let activeCleanup: Effect.Effect<void> = Scope.close(workerScope, Exit.void).pipe(
          Effect.ignore,
        );
        activeCleanups.add(activeCleanup);

        const teardownScope = () =>
          Scope.close(workerScope, Exit.void).pipe(
            Effect.ignore,
            Effect.ensuring(
              Effect.sync(() => {
                activeCleanups.delete(activeCleanup);
              }),
            ),
          );

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
          name: "cursor-sdk",
          env,
          shared: true,
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
        const protocolLoggers = new Map<string, CursorAgentSdk.CursorAgentSdkProtocolLogger>();
        const sessionProtocolLoggers = new Map<
          number,
          CursorAgentSdk.CursorAgentSdkProtocolLogger
        >();
        const closedDone = yield* Deferred.make<void>();
        const stdoutDone = yield* Deferred.make<void>();
        const stderrDone = yield* Deferred.make<void>();
        let nextRequestId = 0;
        let stderrTail = "";
        let closing = false;
        let terminated: { readonly exitCode: number | undefined } | undefined;
        let deadTeardownScheduled = false;

        const pendingRequests = new Map<
          number,
          {
            readonly method: string;
            readonly deferred: Deferred.Deferred<
              CursorWorkerResponsePayload,
              CursorAgentSdk.CursorAgentSdkRunnerError
            >;
            readonly onWorkerRejected?: (() => void) | undefined;
          }
        >();
        const activeRuns = new Map<number, ActiveWorkerRun>();
        const backgroundShellSessions = new Map<
          number,
          {
            listener: (event: CursorAgentSdk.CursorBackgroundShellEvent) => Effect.Effect<void>;
            readonly queue: Queue.Queue<CursorAgentSdk.CursorBackgroundShellEvent | null>;
            closed: boolean;
          }
        >();
        const activeBackgroundShells = new Map<
          string,
          {
            readonly sessionId: number;
            readonly id: string;
            readonly pid: number | undefined;
            readonly command: string;
          }
        >();
        const pendingShellStops = new Map<string, Fiber.Fiber<void, never>>();

        const hasDrainingRuns = () => {
          for (const run of activeRuns.values()) {
            if (run.doneEnqueued) return true;
          }
          return false;
        };

        // Untraced: internal shutdown helper already covered by the enclosing operation span.
        const failAllPending = Effect.fnUntraced(function* (
          exitCode: number | undefined,
          forceActiveRuns: boolean,
        ) {
          const wasTerminated = terminated !== undefined;
          if (!wasTerminated) {
            terminated = { exitCode };
          }
          const pending = Array.from(pendingRequests.entries());
          pendingRequests.clear();
          for (const [, entry] of pending) {
            yield* Deferred.fail(
              entry.deferred,
              workerExitError(entry.method, exitCode, stderrTail),
            );
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
          // Background shells live in the worker's process tree, so a dead worker ends them too.
          for (const [key, shell] of activeBackgroundShells) {
            activeBackgroundShells.delete(key);
            const sessionState = backgroundShellSessions.get(shell.sessionId);
            if (sessionState !== undefined && !sessionState.closed) {
              Queue.offerUnsafe(sessionState.queue, {
                type: "ended",
                id: shell.id,
                pid: shell.pid,
                command: shell.command,
                stopped: true,
                exitCode: undefined,
                outputPath: undefined,
              });
            }
          }
          for (const sessionState of backgroundShellSessions.values()) {
            if (!sessionState.closed) {
              sessionState.closed = true;
              Queue.offerUnsafe(sessionState.queue, null);
            }
          }
          if (!wasTerminated && options.onWorkerTerminated !== undefined) {
            const notify = options.onWorkerTerminated;
            yield* Effect.try({
              try: () => notify(exitCode),
              catch: () => undefined,
            }).pipe(Effect.ignore);
          }
          if (!forceActiveRuns && !deadTeardownScheduled && !hasDrainingRuns()) {
            deadTeardownScheduled = true;
            // Reap the dead worker's scope immediately instead of waiting for old sessions to idle out.
            yield* Effect.forkDetach(close(false).pipe(Effect.ignore));
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
              if (parsed.ok) {
                return Deferred.succeed(entry.deferred, parsed.result).pipe(Effect.asVoid);
              }
              entry.onWorkerRejected?.();
              return Deferred.fail(entry.deferred, fromSerializedFailure(parsed.error)).pipe(
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
            case "protocolLog": {
              const logger =
                (parsed.sessionId === undefined
                  ? undefined
                  : sessionProtocolLoggers.get(parsed.sessionId)) ??
                protocolLoggers.get(parsed.providerSessionId);
              return logger === undefined ? Effect.void : logger(parsed.event).pipe(Effect.ignore);
            }
            case "backgroundShell": {
              const sessionState = backgroundShellSessions.get(parsed.sessionId);
              if (sessionState === undefined || sessionState.closed) return Effect.void;
              const key = `${parsed.sessionId}:${parsed.event.id}`;
              if (parsed.event.type === "started") {
                const { id, pid, command } = parsed.event;
                activeBackgroundShells.set(key, {
                  sessionId: parsed.sessionId,
                  id,
                  pid,
                  command,
                });
                const stop = () => {
                  const stopFiber = Effect.runForkWith(runnerContext)(
                    request(
                      (reqId) => ({
                        id: reqId,
                        type: "stopBackgroundShell",
                        sessionId: parsed.sessionId,
                        shellId: id,
                      }),
                      "shell.stop",
                    ).pipe(
                      Effect.ignore,
                      Effect.ensuring(
                        Effect.sync(() => {
                          if (pendingShellStops.get(key) === stopFiber) {
                            pendingShellStops.delete(key);
                          }
                        }),
                      ),
                    ),
                  );
                  pendingShellStops.set(key, stopFiber);
                };
                Queue.offerUnsafe(sessionState.queue, {
                  type: "started",
                  id,
                  pid,
                  command,
                  stop,
                });
                return Effect.void;
              }
              activeBackgroundShells.delete(key);
              Queue.offerUnsafe(sessionState.queue, {
                type: "ended",
                id: parsed.event.id,
                pid: parsed.event.pid,
                command: parsed.event.command,
                stopped: parsed.event.stopped,
                exitCode: parsed.event.exitCode,
                outputPath: parsed.event.outputPath,
              });
              return Effect.void;
            }
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
                      Deferred.await(stderrDone).pipe(
                        Effect.timeoutOption(Duration.millis(500)),
                        Effect.andThen(failAllPending(Option.getOrUndefined(exitCode), false)),
                      ),
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

        const writeFrame = (
          frame: CursorWorkerRequest,
          method: string,
          onTransmitting?: () => void,
        ) =>
          writeMutex.withPermits(1)(
            Effect.suspend(() => {
              if (terminated !== undefined) {
                return Effect.fail(workerExitError(method, terminated.exitCode, stderrTail));
              }
              onTransmitting?.();
              return Stream.run(
                Stream.encodeText(Stream.make(encodeWorkerFrame(frame))),
                handle.stdin,
              ).pipe(Effect.mapError((cause) => toRunnerError(method, cause)));
            }),
          );

        // Untraced: callers own the enclosing RPC operation span.
        const requestWithId = Effect.fnUntraced(function* (
          id: number,
          frame: CursorWorkerRequest,
          method: string,
          callbacks?: {
            readonly onTransmitting?: () => void;
            readonly onWorkerRejected?: () => void;
          },
        ) {
          if (terminated !== undefined) {
            return yield* workerExitError(method, terminated.exitCode, stderrTail);
          }
          const deferred = yield* Deferred.make<
            CursorWorkerResponsePayload,
            CursorAgentSdk.CursorAgentSdkRunnerError
          >();
          pendingRequests.set(id, {
            method,
            deferred,
            ...(callbacks?.onWorkerRejected === undefined
              ? {}
              : { onWorkerRejected: callbacks.onWorkerRejected }),
          });
          return yield* writeFrame(frame, method, callbacks?.onTransmitting).pipe(
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
        const close: (graceful: boolean) => Effect.Effect<void> = Effect.fnUntraced(function* (
          graceful: boolean,
        ) {
          closing = true;
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
                Effect.andThen(Effect.suspend(teardownScope)),
                Effect.ensuring(Deferred.succeed(closedDone, undefined).pipe(Effect.asVoid)),
              ),
            ),
          );
        });

        // Replace the raw scope closer with forced worker teardown so runner shutdown settles runs.
        activeCleanups.delete(activeCleanup);
        activeCleanup = close(false);
        activeCleanups.add(activeCleanup);

        // Untraced: per-send registration inside CursorAgentSdkSession.send.
        const registerRun = Effect.fnUntraced(function* (sessionId: number, sendId: number) {
          const queue = yield* Queue.unbounded<RunQueueItem>();
          const waitDeferred = yield* Deferred.make<
            RunResult,
            CursorAgentSdk.CursorAgentSdkRunnerError
          >();
          const state: ActiveWorkerRun = { sessionId, queue, waitDeferred, doneEnqueued: false };
          activeRuns.set(sendId, state);
          return state;
        });

        // Untraced: settles only runs belonging to a closed session without disturbing peers.
        const failSessionRuns = Effect.fnUntraced(function* (sessionId: number) {
          const error = new CursorAgentSdk.CursorAgentSdkRunnerError({
            method: "run.wait",
            cause: new Error("Cursor SDK session was closed."),
          });
          for (const run of activeRuns.values()) {
            if (run.sessionId !== sessionId) continue;
            if (!run.doneEnqueued) {
              run.doneEnqueued = true;
              Queue.offerUnsafe(run.queue, { _tag: "done", ok: false, error });
              yield* Deferred.fail(run.waitDeferred, error);
            }
          }
        });

        return {
          scope: workerScope,
          protocolLoggers,
          sessionProtocolLoggers,
          nextId,
          requestWithId,
          request,
          registerRun,
          unregisterRun: (sendId) =>
            Effect.suspend(() => {
              activeRuns.delete(sendId);
              if (terminated !== undefined && !deadTeardownScheduled && !hasDrainingRuns()) {
                deadTeardownScheduled = true;
                return Effect.forkDetach(close(false).pipe(Effect.ignore)).pipe(Effect.asVoid);
              }
              return Effect.void;
            }),
          failSessionRuns,
          // Untraced: called inside session.send which already carries a span.
          setBackgroundShellListener: Effect.fnUntraced(function* (
            sessionId: number,
            listener: (event: CursorAgentSdk.CursorBackgroundShellEvent) => Effect.Effect<void>,
          ) {
            const existing = backgroundShellSessions.get(sessionId);
            if (existing !== undefined && !existing.closed) {
              existing.listener = listener;
              return;
            }
            const queue =
              yield* Queue.unbounded<CursorAgentSdk.CursorBackgroundShellEvent | null>();
            const state = { listener, queue, closed: false };
            backgroundShellSessions.set(sessionId, state);
            // Detached from workerScope so synthesized ended events finish draining on worker crash.
            yield* Effect.forkDetach(
              Effect.gen(function* () {
                while (true) {
                  const event = yield* Queue.take(queue);
                  if (event === null) return;
                  yield* state.listener(event).pipe(Effect.ignore);
                }
              }),
            );
          }),
          drainBackgroundShellStops: (sessionId) =>
            Effect.suspend(() => {
              const prefix = `${sessionId}:`;
              const fibers: Array<Fiber.Fiber<void, never>> = [];
              for (const [key, fiber] of pendingShellStops) {
                if (key.startsWith(prefix)) fibers.push(fiber);
              }
              if (fibers.length === 0) return Effect.void;
              return Effect.forEach(fibers, (fiber) => Fiber.await(fiber), {
                concurrency: "unbounded",
                discard: true,
              }).pipe(Effect.timeoutOption(WORKER_CLOSE_TIMEOUT), Effect.asVoid);
            }),
          closeBackgroundShellSession: (sessionId) => {
            const prefix = `${sessionId}:`;
            for (const key of activeBackgroundShells.keys()) {
              if (key.startsWith(prefix)) activeBackgroundShells.delete(key);
            }
            const state = backgroundShellSessions.get(sessionId);
            if (state !== undefined) {
              backgroundShellSessions.delete(sessionId);
              if (!state.closed) {
                state.closed = true;
                Queue.offerUnsafe(state.queue, null);
              }
            }
          },
          isAlive: () => terminated === undefined && !closing,
          close,
        };
      },
    );

    // Every session and text generation shares one worker: a process per session duplicates the
    // SDK's ~250 MB baseline and pages the host under concurrent threads. Idle, the worker exits.
    interface WorkerLease {
      readonly worker: SpawnedCursorWorker;
      users: number;
    }
    let shared: WorkerLease | undefined;
    const sharedLock = yield* Semaphore.make(1);
    const acquireWorker = sharedLock.withPermits(1)(
      Effect.suspend(() => {
        if (shared !== undefined && shared.worker.isAlive()) {
          shared.users += 1;
          return Effect.succeed(shared);
        }
        return spawnWorker().pipe(
          Effect.map((worker) => {
            const lease: WorkerLease = { worker, users: 1 };
            shared = lease;
            return lease;
          }),
        );
      }),
    );
    const releaseWorker = (lease: WorkerLease) =>
      sharedLock
        .withPermits(1)(
          Effect.sync(() => {
            lease.users -= 1;
            if (lease.users > 0) return false;
            if (shared === lease) shared = undefined;
            return true;
          }),
        )
        .pipe(
          Effect.flatMap((shouldClose) => (shouldClose ? lease.worker.close(true) : Effect.void)),
        );

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

        const lease = yield* acquireWorker;
        const { worker } = lease;
        const sessionId = worker.nextId();
        if (protocolLogger !== undefined) {
          worker.protocolLoggers.set(input.providerSessionId, protocolLogger);
          worker.sessionProtocolLoggers.set(sessionId, protocolLogger);
        }
        let openTransmitted = false;
        let openRejected = false;
        let opened = false;
        let sessionClosed = false;
        let handedOff = false;
        const forgetLogger = Effect.sync(() => {
          worker.closeBackgroundShellSession(sessionId);
          worker.sessionProtocolLoggers.delete(sessionId);
          if (worker.protocolLoggers.get(input.providerSessionId) === protocolLogger) {
            worker.protocolLoggers.delete(input.providerSessionId);
          }
        });
        const closeWorkerSession = Effect.suspend(() => {
          sessionClosed = true;
          return worker
            .drainBackgroundShellStops(sessionId)
            .pipe(
              Effect.andThen(
                worker.request((id) => ({ id, type: "closeSession", sessionId }), "agent.close"),
              ),
              Effect.timeoutOption(WORKER_CLOSE_TIMEOUT),
              Effect.ignore,
              Effect.ensuring(worker.failSessionRuns(sessionId)),
            );
        });
        const release = (closeInWorker: boolean) =>
          (closeInWorker ? closeWorkerSession : Effect.void).pipe(
            Effect.ensuring(forgetLogger),
            Effect.ensuring(releaseWorker(lease)),
          );
        return yield* Effect.gen(function* () {
          const openedAgent = (yield* worker.requestWithId(
            sessionId,
            {
              id: sessionId,
              type: "open",
              operation: input.operation,
              ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
              ...(input.storeCwd === undefined ? {} : { storeCwd: input.storeCwd }),
              options: input.options,
              threadId: input.threadId,
              providerSessionId: input.providerSessionId,
            },
            `agent.${input.operation}`,
            {
              onTransmitting: () => {
                openTransmitted = true;
              },
              onWorkerRejected: () => {
                openRejected = true;
              },
            },
          )) as { readonly agentId: string };
          opened = true;

          const agentId = openedAgent.agentId;
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
            }).pipe(Effect.andThen(release(true))),
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
              if (sendInput.onBackgroundShell !== undefined) {
                yield* worker.setBackgroundShellListener(sessionId, sendInput.onBackgroundShell);
              }
              const runState = yield* worker.registerRun(sessionId, sendId);
              let transmitted = false;
              let acknowledged = false;
              let rejectedByWorker = false;
              let runHandedOff = false;
              return yield* Effect.gen(function* () {
                const started = (yield* worker.requestWithId(
                  sendId,
                  {
                    id: sendId,
                    type: "send",
                    sessionId,
                    message: sendInput.message,
                    ...(sendInput.options === undefined ? {} : { options: sendInput.options }),
                    ...(sendInput.summarize === undefined
                      ? {}
                      : { summarize: sendInput.summarize }),
                    ...(sendInput.resume === undefined ? {} : { resume: sendInput.resume }),
                    ...(sendInput.onBackgroundShell === undefined
                      ? {}
                      : { listenBackgroundShells: true }),
                  },
                  sendInput.resume === true ? "run.resume" : "run.start",
                  {
                    onTransmitting: () => {
                      transmitted = true;
                    },
                    onWorkerRejected: () => {
                      rejectedByWorker = true;
                    },
                  },
                )) as { readonly runId: string; readonly agentId: string };
                acknowledged = true;

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
                }).pipe(Effect.ensuring(worker.unregisterRun(sendId)), Effect.forkIn(worker.scope));

                const run = {
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
                        ) as Effect.Effect<
                          SteerAckOutcome,
                          CursorAgentSdk.CursorAgentSdkRunnerError
                        >,
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
                runHandedOff = true;
                return run;
              }).pipe(
                Effect.ensuring(
                  Effect.suspend(() => {
                    if (runHandedOff) return Effect.void;
                    const stopRun = acknowledged
                      ? worker
                          .request((id) => ({ id, type: "cancel", sendId }), "run.cancel")
                          .pipe(
                            Effect.timeoutOption(WORKER_CLOSE_TIMEOUT),
                            // Other threads share the worker; closing this agent stops the run.
                            Effect.flatMap(
                              Option.match({
                                onNone: () => closeWorkerSession,
                                onSome: () => Effect.void,
                              }),
                            ),
                            Effect.catch(() => closeWorkerSession),
                          )
                      : transmitted && !rejectedByWorker
                        ? // A send interrupted after hitting stdin may still start in the worker.
                          closeWorkerSession
                        : Effect.void;
                    return stopRun.pipe(Effect.ensuring(worker.unregisterRun(sendId)));
                  }),
                ),
              );
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
                  (id) => ({ id, type: "listMessages", sessionId }),
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
              .request(
                (id) => ({ id, type: "readContextUsage", sessionId }),
                "agent.checkpoint.load",
              )
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
                    sessionId,
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
                  worker.request(
                    (id) => ({ id, type: "rewindAfterRun", sessionId, runId }),
                    "agent.rewind",
                  ),
                ),
                Effect.asVoid,
              ),
            isAlive: () => !sessionClosed && worker.isAlive(),
            close: closeSession,
          } satisfies CursorAgentSdk.CursorAgentSdkSession;
          handedOff = true;
          return session;
        }).pipe(
          Effect.ensuring(
            Effect.suspend(() =>
              handedOff ? Effect.void : release(opened || (openTransmitted && !openRejected)),
            ),
          ),
        );
      }),
      textGenerate: Effect.fn("CursorAgentSdkProcessRunner.textGenerate")(function* (input) {
        const lease = yield* acquireWorker;
        const { worker } = lease;
        const textGenerateId = worker.nextId();
        return yield* worker
          .requestWithId(
            textGenerateId,
            {
              id: textGenerateId,
              type: "textGenerate",
              prompt: input.prompt,
              apiKey: input.apiKey,
              model: input.model,
              cwd: input.cwd,
              stateRoot: input.stateRoot,
            },
            "textGenerate",
          )
          .pipe(
            Effect.map((result) => deserializeRunResult(result as SerializedRunResult)),
            Effect.onInterrupt(() =>
              worker
                .request(
                  (id) => ({ id, type: "cancelTextGenerate", textGenerateId }),
                  "textGenerate",
                )
                .pipe(Effect.timeoutOption(WORKER_CLOSE_TIMEOUT), Effect.ignore),
            ),
            Effect.ensuring(releaseWorker(lease)),
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
