import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";

const OPENCODE_SERVER_IDLE_TTL = "30 seconds";

interface OpenCodeServerEntry {
  readonly server: OpenCodeRuntime.OpenCodeServerProcess;
  readonly scope: Scope.Closeable;
  borrowers: number;
}

export class OpenCodeServerOwner extends Context.Service<
  OpenCodeServerOwner,
  {
    readonly withServer: <A, E, R>(
      use: (server: OpenCodeRuntime.OpenCodeServerProcess) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | OpenCodeRuntime.OpenCodeRuntimeError, R>;
    /** The next borrower gets a fresh server; current borrowers keep theirs until they release. */
    readonly retire: Effect.Effect<void>;
  }
>()("@t3tools/provider-opencode/server/OpenCodeServerOwner") {}

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
  const entries = new Map<OpenCodeRuntime.OpenCodeServerProcess, OpenCodeServerEntry>();
  let current: OpenCodeServerEntry | null = null;
  let idleCloseFiber: Fiber.Fiber<void, never> | null = null;

  const cancelIdleClose = Effect.fn("OpenCodeServerOwner.cancelIdleClose")(function* () {
    const fiber = idleCloseFiber;
    idleCloseFiber = null;
    if (fiber !== null) {
      yield* Fiber.interrupt(fiber).pipe(Effect.ignore);
    }
  });

  const closeEntry = Effect.fn("OpenCodeServerOwner.closeEntry")(function* (
    entry: OpenCodeServerEntry,
  ) {
    entries.delete(entry.server);
    if (current === entry) {
      current = null;
    }
    yield* Scope.close(entry.scope, Exit.void).pipe(Effect.ignore);
  });

  const watchServerExit = Effect.fn("OpenCodeServerOwner.watchServerExit")(function* (
    entry: OpenCodeServerEntry,
  ) {
    yield* entry.server.exitCode;
    yield* mutex.withPermit(
      Effect.gen(function* () {
        if (!entries.has(entry.server)) {
          return;
        }
        if (current === entry) {
          yield* cancelIdleClose();
        }
        yield* closeEntry(entry);
      }),
    );
  });

  const acquireServer = mutex.withPermit(
    Effect.gen(function* () {
      yield* cancelIdleClose();
      if (current !== null) {
        if (yield* current.server.isRunning) {
          current.borrowers += 1;
          return current.server;
        }
        yield* closeEntry(current);
      }

      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const serverScope = yield* Scope.make();
          const started = yield* Effect.exit(
            restore(
              runtime
                .startOpenCodeServerProcess({
                  binaryPath: input.binaryPath,
                  directory: input.directory,
                  ...(input.serverPassword !== undefined
                    ? { serverPassword: input.serverPassword }
                    : {}),
                  ...(input.environment ? { environment: input.environment } : {}),
                  ...(input.verify ? { verify: input.verify } : {}),
                })
                .pipe(Effect.provideService(Scope.Scope, serverScope)),
            ),
          );
          if (Exit.isFailure(started)) {
            yield* Scope.close(serverScope, Exit.void).pipe(Effect.ignore);
            return yield* Effect.failCause(started.cause);
          }

          const entry: OpenCodeServerEntry = {
            server: started.value,
            scope: serverScope,
            borrowers: 1,
          };
          entries.set(entry.server, entry);
          current = entry;
          yield* watchServerExit(entry).pipe(Effect.forkIn(ownerScope));
          return entry.server;
        }),
      );
    }),
  );

  const releaseServer = (server: OpenCodeRuntime.OpenCodeServerProcess) =>
    mutex.withPermit(
      Effect.gen(function* () {
        const entry = entries.get(server);
        if (entry === undefined) {
          return;
        }
        entry.borrowers = Math.max(0, entry.borrowers - 1);
        if (entry.borrowers > 0) {
          return;
        }
        if (entry !== current) {
          yield* closeEntry(entry);
          return;
        }
        yield* cancelIdleClose();
        idleCloseFiber = yield* Effect.sleep(OPENCODE_SERVER_IDLE_TTL).pipe(
          Effect.andThen(
            mutex.withPermit(
              Effect.gen(function* () {
                if (current !== entry || entry.borrowers > 0) {
                  return;
                }
                idleCloseFiber = null;
                yield* closeEntry(entry);
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
        for (const entry of entries.values()) {
          yield* closeEntry(entry);
        }
      }),
    ),
  );

  return OpenCodeServerOwner.of({
    withServer: Effect.fn("OpenCodeServerOwner.withServer")(function (use) {
      return Effect.uninterruptibleMask((restore) =>
        restore(acquireServer).pipe(
          Effect.flatMap((server) =>
            restore(use(server)).pipe(Effect.ensuring(releaseServer(server))),
          ),
        ),
      );
    }),
    retire: mutex.withPermit(
      Effect.gen(function* () {
        const entry = current;
        if (entry === null) {
          return;
        }
        yield* cancelIdleClose();
        current = null;
        if (entry.borrowers === 0) {
          yield* closeEntry(entry);
        }
      }),
    ),
  });
});

/** @public */
export const layer = (input: {
  readonly binaryPath: string;
  readonly directory: string;
  readonly serverPassword?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly verify?: (url: string) => Effect.Effect<string, OpenCodeRuntime.OpenCodeRuntimeError>;
}) => Layer.effect(OpenCodeServerOwner, make(input));
