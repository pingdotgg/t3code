import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";

import {
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  type OpenCodeRuntimeShape,
} from "./opencodeRuntime.ts";
import * as OpenCodeServerOwner from "./OpenCodeServerOwner.ts";

const unusedRuntimeMethod = () =>
  Effect.fail(
    new OpenCodeRuntimeError({
      operation: "unused",
      detail: "unused test method",
    }),
  );

const makeRuntime = Effect.gen(function* () {
  const starts = yield* Ref.make(0);
  const closes = yield* Ref.make(0);
  const failNextStart = yield* Ref.make(false);
  const started = yield* Deferred.make<void>();
  const closed = yield* Deferred.make<void>();
  const runtime: OpenCodeRuntimeShape = {
    startOpenCodeServerProcess: () =>
      Effect.gen(function* () {
        if (yield* Ref.getAndSet(failNextStart, false)) {
          return yield* new OpenCodeRuntimeError({
            operation: "startOpenCodeServerProcess",
            detail: "start failed",
          });
        }
        const index = yield* Ref.updateAndGet(starts, (count) => count + 1);
        yield* Deferred.succeed(started, undefined).pipe(Effect.ignore);
        yield* Effect.addFinalizer(() =>
          Ref.update(closes, (count) => count + 1).pipe(
            Effect.andThen(Deferred.succeed(closed, undefined)),
            Effect.ignore,
          ),
        );
        return {
          url: `http://127.0.0.1:${index}`,
          version: "1.14.19",
          isRunning: Effect.succeed(true),
          exitCode: Effect.never,
        };
      }),
    connectToOpenCodeServer: unusedRuntimeMethod,
    runOpenCodeCommand: unusedRuntimeMethod,
    createOpenCodeSdkClient: () => ({}) as never,
    loadOpenCodeInventory: unusedRuntimeMethod,
    loadOpenCodeSkills: unusedRuntimeMethod,
    loadInventoryFromCli: unusedRuntimeMethod,
    loadSkillsFromCli: unusedRuntimeMethod,
  };
  return { runtime, starts, closes, failNextStart, started, closed };
});

it.effect("shares concurrent borrowers and closes after the idle TTL", () =>
  Effect.gen(function* () {
    const testRuntime = yield* makeRuntime;
    const release = yield* Deferred.make<void>();
    yield* Effect.scoped(
      Effect.gen(function* () {
        const owner = yield* OpenCodeServerOwner.make({
          binaryPath: "opencode",
          directory: "/project",
        });
        const useServer = owner.withServer((server) =>
          Deferred.await(release).pipe(Effect.as(server.url)),
        );
        const fibers = yield* Effect.all([useServer, useServer], {
          concurrency: "unbounded",
        }).pipe(Effect.forkChild);
        yield* Deferred.await(testRuntime.started);
        expect(yield* Ref.get(testRuntime.starts)).toBe(1);
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(fibers)).toEqual(["http://127.0.0.1:1", "http://127.0.0.1:1"]);
        yield* TestClock.adjust(Duration.seconds(31));
        yield* Deferred.await(testRuntime.closed);
        expect(yield* Ref.get(testRuntime.closes)).toBe(1);
      }),
    ).pipe(Effect.provideService(OpenCodeRuntime, testRuntime.runtime));
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("retries a failed start and closes on owner scope shutdown", () =>
  Effect.gen(function* () {
    const testRuntime = yield* makeRuntime;
    yield* Ref.set(testRuntime.failNextStart, true);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const owner = yield* OpenCodeServerOwner.make({
          binaryPath: "opencode",
          directory: "/project",
        });
        expect(
          (yield* Effect.exit(owner.withServer((server) => Effect.succeed(server.url))))._tag,
        ).toBe("Failure");
        expect(yield* owner.withServer((server) => Effect.succeed(server.url))).toBe(
          "http://127.0.0.1:1",
        );
      }),
    ).pipe(Effect.provideService(OpenCodeRuntime, testRuntime.runtime));
    expect(yield* Ref.get(testRuntime.starts)).toBe(1);
    expect(yield* Ref.get(testRuntime.closes)).toBe(1);
  }),
);

it.effect("invalidates an exited process so the next borrower starts a new one", () =>
  Effect.gen(function* () {
    const starts = yield* Ref.make(0);
    const processExits: Array<Deferred.Deferred<number>> = [];
    const processClosed = yield* Deferred.make<void>();
    const runtime: OpenCodeRuntimeShape = {
      startOpenCodeServerProcess: () =>
        Effect.gen(function* () {
          const index = yield* Ref.updateAndGet(starts, (count) => count + 1);
          const exitCode = yield* Deferred.make<number>();
          processExits.push(exitCode);
          yield* Effect.addFinalizer(() =>
            Deferred.succeed(processClosed, undefined).pipe(Effect.ignore),
          );
          return {
            url: `http://127.0.0.1:${index}`,
            version: "1.14.19",
            isRunning: Effect.succeed(true),
            exitCode: Deferred.await(exitCode),
          };
        }),
      connectToOpenCodeServer: unusedRuntimeMethod,
      runOpenCodeCommand: unusedRuntimeMethod,
      createOpenCodeSdkClient: () => ({}) as never,
      loadOpenCodeInventory: unusedRuntimeMethod,
      loadOpenCodeSkills: unusedRuntimeMethod,
      loadInventoryFromCli: unusedRuntimeMethod,
      loadSkillsFromCli: unusedRuntimeMethod,
    };

    yield* Effect.scoped(
      Effect.gen(function* () {
        const owner = yield* OpenCodeServerOwner.make({
          binaryPath: "opencode",
          directory: "/project",
        });
        expect(yield* owner.withServer((server) => Effect.succeed(server.url))).toBe(
          "http://127.0.0.1:1",
        );
        yield* Deferred.succeed(processExits[0]!, 1);
        yield* Deferred.await(processClosed);
        expect(yield* owner.withServer((server) => Effect.succeed(server.url))).toBe(
          "http://127.0.0.1:2",
        );
      }),
    ).pipe(Effect.provideService(OpenCodeRuntime, runtime));
    expect(yield* Ref.get(starts)).toBe(2);
  }),
);

it.effect("replaces a dead cached process before its exit watcher runs", () =>
  Effect.gen(function* () {
    const starts = yield* Ref.make(0);
    const closes = yield* Ref.make(0);
    const processRunning: Array<Ref.Ref<boolean>> = [];
    const runtime: OpenCodeRuntimeShape = {
      startOpenCodeServerProcess: () =>
        Effect.gen(function* () {
          const index = yield* Ref.updateAndGet(starts, (count) => count + 1);
          const isRunning = yield* Ref.make(true);
          processRunning.push(isRunning);
          yield* Effect.addFinalizer(() => Ref.update(closes, (count) => count + 1));
          return {
            url: `http://127.0.0.1:${index}`,
            version: "1.14.19",
            isRunning: Ref.get(isRunning),
            exitCode: Effect.never,
          };
        }),
      connectToOpenCodeServer: unusedRuntimeMethod,
      runOpenCodeCommand: unusedRuntimeMethod,
      createOpenCodeSdkClient: () => ({}) as never,
      loadOpenCodeInventory: unusedRuntimeMethod,
      loadOpenCodeSkills: unusedRuntimeMethod,
      loadInventoryFromCli: unusedRuntimeMethod,
      loadSkillsFromCli: unusedRuntimeMethod,
    };

    yield* Effect.scoped(
      Effect.gen(function* () {
        const owner = yield* OpenCodeServerOwner.make({
          binaryPath: "opencode",
          directory: "/project",
        });
        expect(yield* owner.withServer((server) => Effect.succeed(server.url))).toBe(
          "http://127.0.0.1:1",
        );
        yield* Ref.set(processRunning[0]!, false);

        expect(yield* owner.withServer((server) => Effect.succeed(server.url))).toBe(
          "http://127.0.0.1:2",
        );
        expect(yield* Ref.get(starts)).toBe(2);
        expect(yield* Ref.get(closes)).toBe(1);
      }),
    ).pipe(Effect.provideService(OpenCodeRuntime, runtime));
  }),
);

it.effect("cleans up an interrupted startup and allows a retry", () =>
  Effect.gen(function* () {
    const starts = yield* Ref.make(0);
    const firstStartEntered = yield* Deferred.make<void>();
    const firstStartClosed = yield* Deferred.make<void>();
    const runtime: OpenCodeRuntimeShape = {
      startOpenCodeServerProcess: () =>
        Effect.gen(function* () {
          const index = yield* Ref.updateAndGet(starts, (count) => count + 1);
          yield* Effect.addFinalizer(() =>
            index === 1
              ? Deferred.succeed(firstStartClosed, undefined).pipe(Effect.ignore)
              : Effect.void,
          );
          if (index === 1) {
            yield* Deferred.succeed(firstStartEntered, undefined);
            return yield* Effect.never;
          }
          return {
            url: `http://127.0.0.1:${index}`,
            version: "1.14.19",
            isRunning: Effect.succeed(true),
            exitCode: Effect.never,
          };
        }),
      connectToOpenCodeServer: unusedRuntimeMethod,
      runOpenCodeCommand: unusedRuntimeMethod,
      createOpenCodeSdkClient: () => ({}) as never,
      loadOpenCodeInventory: unusedRuntimeMethod,
      loadOpenCodeSkills: unusedRuntimeMethod,
      loadInventoryFromCli: unusedRuntimeMethod,
      loadSkillsFromCli: unusedRuntimeMethod,
    };

    yield* Effect.scoped(
      Effect.gen(function* () {
        const owner = yield* OpenCodeServerOwner.make({
          binaryPath: "opencode",
          directory: "/project",
        });
        const firstBorrower = yield* owner
          .withServer((server) => Effect.succeed(server.url))
          .pipe(Effect.forkChild);
        yield* Deferred.await(firstStartEntered);
        yield* Fiber.interrupt(firstBorrower);
        yield* Deferred.await(firstStartClosed);
        expect(yield* owner.withServer((server) => Effect.succeed(server.url))).toBe(
          "http://127.0.0.1:2",
        );
      }),
    ).pipe(Effect.provideService(OpenCodeRuntime, runtime));
  }),
);

it.effect("releases an interrupted borrower and closes after the idle TTL", () =>
  Effect.gen(function* () {
    const testRuntime = yield* makeRuntime;
    const borrowerEntered = yield* Deferred.make<void>();
    yield* Effect.scoped(
      Effect.gen(function* () {
        const owner = yield* OpenCodeServerOwner.make({
          binaryPath: "opencode",
          directory: "/project",
        });
        const borrower = yield* owner
          .withServer(() =>
            Deferred.succeed(borrowerEntered, undefined).pipe(Effect.andThen(Effect.never)),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(borrowerEntered);
        yield* Fiber.interrupt(borrower);
        yield* TestClock.adjust(Duration.seconds(31));
        yield* Deferred.await(testRuntime.closed);
        expect(yield* Ref.get(testRuntime.closes)).toBe(1);
      }),
    ).pipe(Effect.provideService(OpenCodeRuntime, testRuntime.runtime));
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("verify path uses unverified spawn and closes the scope when verify fails", () =>
  Effect.gen(function* () {
    const starts = yield* Ref.make(0);
    const closes = yield* Ref.make(0);
    const legacyStarts = yield* Ref.make(0);
    const runtime: OpenCodeRuntimeShape = {
      startOpenCodeServerProcess: () =>
        Ref.updateAndGet(legacyStarts, (count) => count + 1).pipe(
          Effect.andThen(
            Effect.fail(
              new OpenCodeRuntimeError({
                operation: "startOpenCodeServerProcess",
                detail: "legacy start must not run on the verify path",
              }),
            ),
          ),
        ),
      startUnverifiedOpenCodeServerProcess: () =>
        Effect.gen(function* () {
          const index = yield* Ref.updateAndGet(starts, (count) => count + 1);
          yield* Effect.addFinalizer(() => Ref.update(closes, (count) => count + 1));
          return {
            url: `http://127.0.0.1:${index}`,
            isRunning: Effect.succeed(true),
            exitCode: Effect.never,
          };
        }),
      connectToOpenCodeServer: unusedRuntimeMethod,
      runOpenCodeCommand: unusedRuntimeMethod,
      createOpenCodeSdkClient: () => ({}) as never,
      loadOpenCodeInventory: unusedRuntimeMethod,
      loadOpenCodeSkills: unusedRuntimeMethod,
      loadInventoryFromCli: unusedRuntimeMethod,
      loadSkillsFromCli: unusedRuntimeMethod,
    };

    yield* Effect.scoped(
      Effect.gen(function* () {
        // Success: unverified spawn + verify version, legacy start untouched.
        const owner = yield* OpenCodeServerOwner.make({
          binaryPath: "opencode",
          directory: "/project",
          verify: () => Effect.succeed("2.0.18"),
        });
        const server = yield* owner.withServer((value) => Effect.succeed(value));
        expect(server.version).toBe("2.0.18");
        expect(yield* Ref.get(starts)).toBe(1);
        expect(yield* Ref.get(legacyStarts)).toBe(0);

        // Failure: the spawn scope the verify opened is closed — no leak.
        const failing = yield* OpenCodeServerOwner.make({
          binaryPath: "opencode",
          directory: "/project",
          verify: () =>
            Effect.fail(
              new OpenCodeRuntimeError({
                operation: "server.info",
                detail: "The server at http://127.0.0.1:2 is not an OpenCode 2 server.",
              }),
            ),
        }).pipe(Effect.provideService(OpenCodeRuntime, runtime));
        expect(
          (yield* Effect.exit(failing.withServer((value) => Effect.succeed(value.url))))._tag,
        ).toBe("Failure");
        expect(yield* Ref.get(starts)).toBe(2);
        expect(yield* Ref.get(closes)).toBe(1);
        expect(yield* Ref.get(legacyStarts)).toBe(0);
      }),
    ).pipe(Effect.provideService(OpenCodeRuntime, runtime));
    expect(yield* Ref.get(starts)).toBe(2);
    // Both spawns closed exactly once: the failed verify at failure time,
    // the successful one at owner scope shutdown. No double-stop.
    expect(yield* Ref.get(closes)).toBe(2);
    expect(yield* Ref.get(legacyStarts)).toBe(0);
  }),
);

it.effect("verify path falls back to legacy start without the unverified entry point", () =>
  Effect.gen(function* () {
    const starts = yield* Ref.make(0);
    const closes = yield* Ref.make(0);
    const { startUnverifiedOpenCodeServerProcess: _absent, ...legacyOnly } = (yield* makeRuntime)
      .runtime;
    void _absent;
    const runtime: OpenCodeRuntimeShape = {
      ...legacyOnly,
      startOpenCodeServerProcess: () =>
        Effect.gen(function* () {
          yield* Ref.update(starts, (count) => count + 1);
          yield* Effect.addFinalizer(() => Ref.update(closes, (count) => count + 1));
          return {
            url: "http://127.0.0.1:9",
            version: "1.14.19",
            isRunning: Effect.succeed(true),
            exitCode: Effect.never,
          };
        }),
    };

    yield* Effect.scoped(
      Effect.gen(function* () {
        // v1 behavior unchanged: without the unverified entry point the
        // owner uses the legacy start even when a verify hook is present.
        const owner = yield* OpenCodeServerOwner.make({
          binaryPath: "opencode",
          directory: "/project",
          verify: () => Effect.succeed("2.0.18"),
        });
        const server = yield* owner.withServer((value) => Effect.succeed(value));
        expect(server.url).toBe("http://127.0.0.1:9");
        expect(server.version).toBe("2.0.18");
        expect(yield* Ref.get(starts)).toBe(1);
      }),
    ).pipe(Effect.provideService(OpenCodeRuntime, runtime));
    expect(yield* Ref.get(starts)).toBe(1);
    expect(yield* Ref.get(closes)).toBe(1);
  }),
);
