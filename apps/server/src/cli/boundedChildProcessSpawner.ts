import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export interface BoundedChildProcessSpawnerOptions {
  readonly termGraceMs?: number;
  readonly killGraceMs?: number;
}

const DEFAULT_TERM_GRACE_MS = 2_000;
const DEFAULT_KILL_GRACE_MS = 1_000;

const normalizedDelay = (value: number | undefined, fallback: number) =>
  value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, value);

const isStillRunning = (handle: ChildProcessSpawner.ChildProcessHandle) =>
  handle.isRunning.pipe(Effect.orElseSucceed(() => true));

const waitUntilStopped = Effect.fn("BoundedChildProcessSpawner.waitUntilStopped")(function (
  handle: ChildProcessSpawner.ChildProcessHandle,
  timeoutMs: number,
) {
  return Effect.timeoutOrElse(handle.exitCode.pipe(Effect.exit, Effect.as(true)), {
    duration: timeoutMs,
    orElse: () => Effect.succeed(false),
  });
});

export const make = (
  delegate: ChildProcessSpawner.ChildProcessSpawner["Service"],
  options: BoundedChildProcessSpawnerOptions = {},
) => {
  const termGraceMs = normalizedDelay(options.termGraceMs, DEFAULT_TERM_GRACE_MS);
  const killGraceMs = normalizedDelay(options.killGraceMs, DEFAULT_KILL_GRACE_MS);
  const sendSignal = Effect.fn("BoundedChildProcessSpawner.sendSignal")(function* (
    handle: ChildProcessSpawner.ChildProcessHandle,
    signal: ChildProcess.Signal,
  ) {
    yield* handle.kill({ killSignal: signal }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to signal child process", {
          cause,
          pid: Number(handle.pid),
          signal,
        }),
      ),
      Effect.forkDetach({ startImmediately: true }),
    );
  });

  const killForShutdown = Effect.fn("BoundedChildProcessSpawner.killForShutdown")(function* (
    handle: ChildProcessSpawner.ChildProcessHandle,
    killOptions?: ChildProcess.KillOptions,
  ) {
    if (!(yield* isStillRunning(handle))) return;

    const initialSignal = killOptions?.killSignal ?? "SIGTERM";
    const initialGraceMs =
      initialSignal === "SIGKILL"
        ? killGraceMs
        : normalizedDelay(
            killOptions?.forceKillAfter === undefined
              ? undefined
              : Duration.toMillis(killOptions.forceKillAfter),
            termGraceMs,
          );
    yield* sendSignal(handle, initialSignal);
    const stoppedAfterInitialSignal = yield* waitUntilStopped(handle, initialGraceMs);
    if (stoppedAfterInitialSignal) return;

    if (initialSignal !== "SIGKILL") {
      yield* sendSignal(handle, "SIGKILL");
      if (yield* waitUntilStopped(handle, killGraceMs)) return;
    }

    yield* Effect.logWarning("Child process did not stop after SIGKILL grace period", {
      pid: Number(handle.pid),
      killGraceMs,
    });
  });

  const spawn = Effect.fn("BoundedChildProcessSpawner.spawn")(function* (
    command: ChildProcess.Command,
  ) {
    const callerScope = yield* Scope.Scope;
    const childScope = yield* Scope.make("sequential");
    const spawned = yield* delegate
      .spawn(command)
      .pipe(Effect.provideService(Scope.Scope, childScope), Effect.exit);

    if (Exit.isFailure(spawned)) {
      yield* Scope.close(childScope, Exit.void).pipe(Effect.ignoreCause({ log: true }));
      return yield* Effect.failCause(spawned.cause);
    }

    const delegateHandle = spawned.value;
    let referenced = true;
    let shutdownAttempted = false;
    const killOnceForShutdown = (killOptions?: ChildProcess.KillOptions) =>
      Effect.suspend(() => {
        if (shutdownAttempted) return Effect.void;
        shutdownAttempted = true;
        return killForShutdown(delegateHandle, killOptions);
      });
    const handle = ChildProcessSpawner.makeHandle({
      pid: delegateHandle.pid,
      exitCode: delegateHandle.exitCode,
      isRunning: delegateHandle.isRunning,
      kill: (killOptions) =>
        Effect.suspend(() =>
          callerScope.state._tag === "Closed"
            ? killOnceForShutdown(killOptions)
            : delegateHandle.kill(killOptions),
        ),
      stdin: delegateHandle.stdin,
      stdout: delegateHandle.stdout,
      stderr: delegateHandle.stderr,
      all: delegateHandle.all,
      getInputFd: delegateHandle.getInputFd,
      getOutputFd: delegateHandle.getOutputFd,
      unref: delegateHandle.unref.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            referenced = false;
          }),
        ),
        Effect.map((reref) =>
          reref.pipe(
            Effect.tap(() =>
              Effect.suspend(() => {
                if (callerScope.state._tag === "Closed") return killOnceForShutdown();
                referenced = true;
                return Effect.void;
              }),
            ),
          ),
        ),
      ),
    });
    yield* Effect.addFinalizer(() => (referenced ? killOnceForShutdown() : Effect.void));
    yield* handle.exitCode.pipe(
      Effect.exit,
      Effect.andThen(Scope.close(childScope, Exit.void)),
      Effect.ignoreCause({ log: true }),
      Effect.forkDetach({ startImmediately: true }),
    );

    return handle;
  }, Effect.uninterruptible);

  return ChildProcessSpawner.make(spawn);
};

export const layer = (options?: BoundedChildProcessSpawnerOptions) =>
  Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.map(ChildProcessSpawner.ChildProcessSpawner, (delegate) => make(delegate, options)),
  );
