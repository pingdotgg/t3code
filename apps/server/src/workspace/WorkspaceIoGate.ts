import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PlatformError from "effect/PlatformError";
import * as Semaphore from "effect/Semaphore";

export interface WorkspaceIoGateOptions {
  readonly maxInFlight: number;
  readonly timeout: Duration.Input;
}

/**
 * Caps background filesystem calls on project paths. Node runs async fs calls on libuv's shared
 * pool (4 threads by default), and a call on a path whose mount stops answering holds its thread
 * until the kernel returns; interrupting the fiber does not free it. A permit is therefore held
 * until the call itself settles, so hung project paths can never take the whole pool.
 */
export const makeWorkspaceIoGate = (options: WorkspaceIoGateOptions) => {
  const permits = Semaphore.makeUnsafe(options.maxInFlight);
  // The gated effect must issue at most one fs call at a time; each permit stands for one thread.
  const run = <A, E>(
    path: string,
    effect: Effect.Effect<A, E>,
  ): Effect.Effect<A, E | PlatformError.PlatformError> =>
    Effect.uninterruptibleMask((restore) =>
      restore(Semaphore.take(permits, 1)).pipe(
        Effect.andThen(
          effect.pipe(
            Effect.exit,
            Effect.ensuring(Semaphore.release(permits, 1)),
            Effect.forkDetach,
          ),
        ),
      ),
    ).pipe(
      Effect.flatMap(Fiber.join),
      Effect.flatten,
      Effect.timeoutOrElse({
        duration: options.timeout,
        orElse: () =>
          Effect.logWarning("Filesystem call on a project path is not responding", { path }).pipe(
            Effect.andThen(
              Effect.fail(
                PlatformError.systemError({
                  _tag: "TimedOut",
                  module: "FileSystem",
                  method: "WorkspaceIoGate.run",
                  pathOrDescriptor: path,
                  description: "The filesystem did not respond in time.",
                }),
              ),
            ),
          ),
      }),
    );
  return { run };
};

// One per process, like the libuv pool it protects. Tests override it with a small timeout.
export class WorkspaceIoGate extends Context.Reference<ReturnType<typeof makeWorkspaceIoGate>>(
  "t3/workspace/WorkspaceIoGate",
  {
    defaultValue: () => makeWorkspaceIoGate({ maxInFlight: 2, timeout: Duration.seconds(10) }),
  },
) {}
