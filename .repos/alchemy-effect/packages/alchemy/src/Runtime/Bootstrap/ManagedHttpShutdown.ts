import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import type { Server } from "node:http";

/** Internal HTTP and dependency lifetimes, separate from managed run fibers. */
export class ManagedHttpShutdown extends Context.Service<
  ManagedHttpShutdown,
  {
    readonly scope: Scope.Closeable;
    readonly dependencies: Scope.Closeable;
    readonly servers: Set<Server>;
    readonly drainTimeoutMs: number;
    readonly isStopping: () => boolean;
    readonly observeRequest: (fiber: Fiber.Fiber<unknown, unknown>) => void;
    readonly runnerFinished: (
      exit: Exit.Exit<unknown, unknown>,
      last: boolean,
    ) => void;
  }
>()("Alchemy.Runtime.ManagedHttpShutdown") {}

/**
 * Coordinate shutdown of an Alchemy-owned Fly Service process, including HTTP
 * requests, background runners, and their shared dependencies.
 *
 * The Fly bootstrap enables this when `ALCHEMY_FLY_SHUTDOWN_TIMEOUT_MS` is set.
 * The Service provider sets it for managed Services using blue/green or an
 * explicit shutdown policy. Raw images and external servers own their shutdown.
 *
 * This is a process-entrypoint helper, not a request timeout or a general-purpose
 * Effect combinator. Running it installs process-wide SIGTERM and SIGINT
 * listeners. They coexist with other listeners, but cannot prevent another
 * listener from exiting the process. Importing this module installs no listeners.
 *
 * Shutdown stops HTTP acceptance and interrupts background runners concurrently.
 * Existing responses and request finalizers drain before shared dependencies
 * close. Deadlines start on a signal, runner failure, completion of all runner
 * bodies, or program completion, not after `timeoutMs` of normal execution.
 *
 * At 80% of the budget, remaining HTTP connections are forcibly closed. At 90%,
 * a native timer calls `process.exit(1)`, even if Effect finalizers are still
 * running. This reserves time before Fly's own termination deadline; it does
 * not guarantee cleanup completes. These timers require a responsive event loop.
 * Repeated signals do not extend the budget. Listeners and timers are removed
 * when the wrapper's scope closes, unless the process exits first.
 *
 * @param program - The whole managed process program, not an individual handler.
 * @param timeoutMs - Fly's configured shutdown budget, from 1 to 300000 ms.
 * @returns Whether shutdown was requested before the program completed.
 * Cleanup failures and exceeded drain deadlines fail the Effect; the caller
 * owns the normal process exit after successful cleanup.
 * @internal
 */
export const withManagedHttpShutdown = (
  program: Effect.Effect<unknown, unknown>,
  timeoutMs: number,
) =>
  Effect.gen(function* () {
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > 300_000
    ) {
      return yield* Effect.fail(
        new Error(
          "ALCHEMY_FLY_SHUTDOWN_TIMEOUT_MS must be a positive integer at most 300000",
        ),
      );
    }

    const signal = yield* Deferred.make<void>();
    const scope = yield* Scope.make("parallel");
    const dependencies = yield* Scope.make();
    const servers = new Set<Server>();
    let stopping = false;
    let drained = false;
    let timedOut = false;
    const runnerFailures: Cause.Cause<unknown>[] = [];
    const requestFailures: Cause.Cause<unknown>[] = [];
    const requests = new Set<Fiber.Fiber<unknown, unknown>>();
    let drainDeadline: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    // Leave time for request/instance finalizers, then for Fly's own stop deadline.
    const drainTimeoutMs = Math.floor(timeoutMs * 0.8);
    const exitTimeoutMs = Math.min(Math.floor(timeoutMs * 0.9), 2 ** 31 - 1);

    // Native timers remain independent of uninterruptible Effect finalizers.
    const beginShutdown = () => {
      if (stopping) return;
      stopping = true;
      drainDeadline = setTimeout(() => {
        if (drained) return;
        timedOut = true;
        console.error(
          "Managed HTTP drain deadline exceeded; closing connections.",
        );
        for (const server of servers) server.closeAllConnections();
      }, drainTimeoutMs);
      deadline = setTimeout(() => {
        console.error("Managed HTTP shutdown deadline exceeded; exiting.");
        process.exit(1);
      }, exitTimeoutMs);
    };

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const onSignal = () => {
          beginShutdown();
          Deferred.doneUnsafe(signal, Effect.void);
        };
        process.on("SIGTERM", onSignal);
        process.on("SIGINT", onSignal);
        return onSignal;
      }),
      (onSignal) =>
        Effect.sync(() => {
          process.off("SIGTERM", onSignal);
          process.off("SIGINT", onSignal);
          if (drainDeadline !== undefined) clearTimeout(drainDeadline);
          if (deadline !== undefined) clearTimeout(deadline);
        }),
    );
    yield* Effect.addFinalizer((exit) => Scope.close(dependencies, exit));
    yield* Effect.addFinalizer((exit) => Scope.close(scope, exit));

    const fiber = yield* program.pipe(
      Effect.provideService(ManagedHttpShutdown, {
        scope,
        dependencies,
        servers,
        drainTimeoutMs,
        isStopping: () => stopping,
        observeRequest: (request) => {
          if (requests.has(request)) return;
          requests.add(request);
          request.addObserver((exit) => {
            requests.delete(request);
            if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
              requestFailures.push(exit.cause);
              console.error(
                "Managed HTTP request cleanup failed",
                Cause.pretty(exit.cause),
              );
            }
          });
        },
        runnerFinished: (exit, last) => {
          if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
            runnerFailures.push(exit.cause);
            console.error(
              "Managed process cleanup failed",
              Cause.pretty(exit.cause),
            );
            beginShutdown();
            Deferred.doneUnsafe(signal, Effect.void);
          } else if (last) {
            beginShutdown();
          }
        },
      }),
      Effect.forkChild,
    );
    const interrupted = yield* Effect.raceFirst(
      Deferred.await(signal).pipe(Effect.as(true)),
      Fiber.await(fiber).pipe(Effect.as(false)),
    );
    yield* Effect.sync(beginShutdown);
    // Neither HTTP drain nor one worker's finalizers may delay another's stop.
    const [httpExit, programExit] = yield* Effect.all(
      [
        Scope.close(scope, Exit.void).pipe(Effect.exit),
        Effect.gen(function* () {
          if (interrupted) yield* Fiber.interrupt(fiber);
          return yield* Fiber.await(fiber);
        }),
      ],
      { concurrency: "unbounded" },
    );
    // Socket closure is not completion of the request fiber's finalizers.
    yield* Fiber.awaitAll(requests);
    drained = true;
    const dependencyExit = yield* Scope.close(dependencies, programExit).pipe(
      Effect.exit,
    );
    const failures = runnerFailures.concat(
      requestFailures,
      [httpExit, programExit, dependencyExit].flatMap((exit) =>
        Exit.isFailure(exit) &&
        !(interrupted && Cause.hasInterruptsOnly(exit.cause))
          ? [exit.cause]
          : [],
      ),
    );
    for (const cause of failures) {
      yield* Effect.logError("Managed process cleanup failed", cause);
    }
    if (failures.length > 0) return yield* Effect.failCause(failures[0]!);
    if (timedOut) {
      return yield* Effect.fail(
        new Error("Managed process drain deadline exceeded"),
      );
    }
    return interrupted;
  }).pipe(Effect.scoped);
