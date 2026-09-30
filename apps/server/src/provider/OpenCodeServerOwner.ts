import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import * as OpenCodeRuntime from "./opencodeRuntime.ts";

const OPENCODE_SERVER_IDLE_TTL = "30 seconds";

interface OpenCodeServerOwnerState {
  server: OpenCodeRuntime.OpenCodeServerProcess | null;
  serverScope: Scope.Closeable | null;
  borrowers: number;
  idleCloseFiber: Fiber.Fiber<void, never> | null;
}

export class OpenCodeServerOwner extends Context.Service<
  OpenCodeServerOwner,
  {
    readonly withServer: <A, E, R>(
      use: (server: OpenCodeRuntime.OpenCodeServerProcess) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | OpenCodeRuntime.OpenCodeRuntimeError, R>;
  }
>()("t3/provider/OpenCodeServerOwner") {}

/** Owns the lazy local OpenCode server shared by one provider instance.
 *
 * Lifetime for the opencode2 verify path is identical to v1: a spawned
 * server is bound to its `serverScope`, shared between borrowers, and
 * stopped after the idle TTL or when the owner's scope closes. The only
 * difference is the readiness gate — `verify` replaces the 1.x
 * `global.health` check (see `startAndVerify`).
 */
export const make = Effect.fn("OpenCodeServerOwner.make")(function* (input: {
  readonly binaryPath: string;
  readonly directory: string;
  readonly serverPassword?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly verify?: (url: string) => Effect.Effect<string, OpenCodeRuntime.OpenCodeRuntimeError>;
}) {
  const runtime = yield* OpenCodeRuntime.OpenCodeRuntime;
  const ownerScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );
  const mutex = yield* Semaphore.make(1);
  const state: OpenCodeServerOwnerState = {
    server: null,
    serverScope: null,
    borrowers: 0,
    idleCloseFiber: null,
  };

  const cancelIdleClose = Effect.fn("OpenCodeServerOwner.cancelIdleClose")(function* () {
    const fiber = state.idleCloseFiber;
    state.idleCloseFiber = null;
    if (fiber !== null) {
      yield* Fiber.interrupt(fiber).pipe(Effect.ignore);
    }
  });

  const closeServer = Effect.fn("OpenCodeServerOwner.closeServer")(function* (
    expected?: OpenCodeRuntime.OpenCodeServerProcess,
  ) {
    if (expected !== undefined && state.server !== expected) {
      return;
    }
    const scope = state.serverScope;
    state.server = null;
    state.serverScope = null;
    if (scope !== null) {
      yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
    }
  });

  const watchServerExit = Effect.fn("OpenCodeServerOwner.watchServerExit")(function* (
    server: OpenCodeRuntime.OpenCodeServerProcess,
  ) {
    yield* server.exitCode;
    yield* mutex.withPermit(
      Effect.gen(function* () {
        if (state.server !== server) {
          return;
        }
        yield* cancelIdleClose();
        yield* closeServer(server);
      }),
    );
  });

  const startAndVerify = (
    serverScope: Scope.Scope,
    verify:
      | ((url: string) => Effect.Effect<string, OpenCodeRuntime.OpenCodeRuntimeError>)
      | undefined,
  ) =>
    Effect.gen(function* () {
      // A caller-supplied verify replaces the runtime's 1.x `global.health`
      // gate: spawn without it when the runtime offers that entry point. A
      // real 2.x server answers the legacy endpoint with SPA HTML, so the
      // gate would fail before this hook runs. Without a verify (the v1 path)
      // the legacy start is used untouched.
      const startArgs = {
        binaryPath: input.binaryPath,
        directory: input.directory,
        ...(input.serverPassword !== undefined ? { serverPassword: input.serverPassword } : {}),
        ...(input.environment ? { environment: input.environment } : {}),
      };
      if (verify === undefined) {
        return yield* runtime
          .startOpenCodeServerProcess(startArgs)
          .pipe(Effect.provideService(Scope.Scope, serverScope));
      }
      // Verify-path: a failed verify must not leak a spawned process. The
      // scope below is closed by the caller's `Effect.exit` failure branch
      // (see `acquireServer`), so an unverified server is stopped exactly
      // like a verified one that later idles out — no separate cleanup.
      const unverifiedStart = runtime.startUnverifiedOpenCodeServerProcess;
      const server =
        unverifiedStart !== undefined
          ? yield* unverifiedStart(startArgs).pipe(Effect.provideService(Scope.Scope, serverScope))
          : yield* runtime
              .startOpenCodeServerProcess(startArgs)
              .pipe(Effect.provideService(Scope.Scope, serverScope));
      return { ...server, version: yield* verify(server.url) };
    });

  const acquireServer = mutex.withPermit(
    Effect.gen(function* () {
      yield* cancelIdleClose();
      if (state.server !== null) {
        if (yield* state.server.isRunning) {
          state.borrowers += 1;
          return state.server;
        }
        yield* closeServer(state.server);
      }

      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const serverScope = yield* Scope.make();
          const started = yield* Effect.exit(restore(startAndVerify(serverScope, input.verify)));
          if (Exit.isFailure(started)) {
            yield* Scope.close(serverScope, Exit.void).pipe(Effect.ignore);
            return yield* Effect.failCause(started.cause);
          }

          const server = started.value;
          state.server = server;
          state.serverScope = serverScope;
          state.borrowers = 1;
          yield* watchServerExit(server).pipe(Effect.forkIn(ownerScope));
          return server;
        }),
      );
    }),
  );

  const releaseServer = (server: OpenCodeRuntime.OpenCodeServerProcess) =>
    mutex.withPermit(
      Effect.gen(function* () {
        if (state.server !== server) {
          return;
        }
        state.borrowers = Math.max(0, state.borrowers - 1);
        if (state.borrowers > 0) {
          return;
        }
        yield* cancelIdleClose();
        state.idleCloseFiber = yield* Effect.sleep(OPENCODE_SERVER_IDLE_TTL).pipe(
          Effect.andThen(
            mutex.withPermit(
              Effect.gen(function* () {
                if (state.server !== server || state.borrowers > 0) {
                  return;
                }
                state.idleCloseFiber = null;
                yield* closeServer(server);
              }),
            ),
          ),
          Effect.forkIn(ownerScope),
        );
      }),
    );

  yield* Effect.addFinalizer(() =>
    mutex.withPermit(
      Effect.gen(function* () {
        yield* cancelIdleClose();
        state.borrowers = 0;
        yield* closeServer();
      }),
    ),
  );

  return OpenCodeServerOwner.of({
    withServer: (use) =>
      Effect.uninterruptibleMask((restore) =>
        restore(acquireServer).pipe(
          Effect.flatMap((server) =>
            restore(use(server)).pipe(Effect.ensuring(releaseServer(server))),
          ),
        ),
      ),
  });
});

/** @public Service construction is part of the canonical Effect module API. */
export const layer = (input: {
  readonly binaryPath: string;
  readonly directory: string;
  readonly serverPassword?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly verify?: (url: string) => Effect.Effect<string, OpenCodeRuntime.OpenCodeRuntimeError>;
}) => Layer.effect(OpenCodeServerOwner, make(input));
