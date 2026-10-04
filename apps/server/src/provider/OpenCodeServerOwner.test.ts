import { it } from "@effect/vitest";
import { Deferred, Duration, Effect, Exit, Fiber, Ref } from "effect";
import { TestClock } from "effect/testing";
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

type StartedServer = {
  readonly url: string;
  readonly running: Ref.Ref<boolean>;
  readonly exit: Deferred.Deferred<number>;
  readonly closed: Deferred.Deferred<void>;
};

/**
 * A runtime double whose servers report their own exit, so the owner's
 * "restart a dead server" path runs against the real `isRunning` contract
 * instead of a shortcut.
 */
const makeRuntime = Effect.gen(function* () {
  const starts = yield* Ref.make(0);
  const closes = yield* Ref.make(0);
  const spawned: Array<StartedServer> = [];
  const started = yield* Deferred.make<StartedServer>();
  const runtime: OpenCodeRuntimeShape = {
    startOpenCodeServerProcess: () =>
      Effect.gen(function* () {
        const index = yield* Ref.updateAndGet(starts, (count) => count + 1);
        const running = yield* Ref.make(true);
        const exit = yield* Deferred.make<number>();
        const closed = yield* Deferred.make<void>();
        const server = { url: `http://127.0.0.1:${4000 + index}`, running, exit, closed };
        spawned.push(server);
        yield* Deferred.succeed(started, server).pipe(Effect.ignore);
        yield* Effect.addFinalizer(() =>
          Ref.update(closes, (count) => count + 1).pipe(
            Effect.andThen(Deferred.succeed(closed, undefined)),
            Effect.ignore,
          ),
        );
        return {
          url: server.url,
          isRunning: Ref.get(running),
          exitCode: Deferred.await(exit),
        };
      }),
    connectToOpenCodeServer: unusedRuntimeMethod,
    runOpenCodeCommand: unusedRuntimeMethod,
    createOpenCodeSdkClient: () => ({}) as never,
    loadOpenCodeInventory: unusedRuntimeMethod,
    loadOpenCodeSkills: unusedRuntimeMethod,
    loadOpenCodeSkillsForCwd: unusedRuntimeMethod,
    loadInventoryFromCli: unusedRuntimeMethod,
  };
  return { runtime, starts, closes, spawned, started };
});

it.effect("shares one spawn between concurrent borrowers and closes after the idle TTL", () =>
  Effect.gen(function* () {
    const testRuntime = yield* makeRuntime;
    const release = yield* Deferred.make<void>();
    yield* Effect.scoped(
      Effect.gen(function* () {
        const owner = yield* OpenCodeServerOwner.make({ binaryPath: "opencode" });
        const useServer = owner.withServer((server) =>
          Deferred.await(release).pipe(Effect.as(server.url)),
        );
        const borrowers = yield* Effect.all([useServer, useServer], {
          concurrency: "unbounded",
        }).pipe(Effect.forkChild);
        yield* Deferred.await(testRuntime.started);
        expect(yield* Ref.get(testRuntime.starts)).toBe(1);
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(borrowers)).toEqual([
          "http://127.0.0.1:4001",
          "http://127.0.0.1:4001",
        ]);
        yield* TestClock.adjust(Duration.seconds(31));
        yield* Deferred.await(testRuntime.spawned[0]!.closed);
        expect(yield* Ref.get(testRuntime.closes)).toBe(1);
      }),
    ).pipe(Effect.provideService(OpenCodeRuntime, testRuntime.runtime));
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("restarts a server that died while it was lent", () =>
  Effect.gen(function* () {
    const testRuntime = yield* makeRuntime;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const owner = yield* OpenCodeServerOwner.make({ binaryPath: "opencode" });
        expect(yield* owner.withServer((server) => Effect.succeed(server.url))).toBe(
          "http://127.0.0.1:4001",
        );
        const first = testRuntime.spawned[0]!;
        yield* Ref.set(first.running, false);
        yield* Deferred.succeed(first.exit, 1);
        yield* Deferred.await(first.closed);
        expect(yield* owner.withServer((server) => Effect.succeed(server.url))).toBe(
          "http://127.0.0.1:4002",
        );
      }),
    ).pipe(Effect.provideService(OpenCodeRuntime, testRuntime.runtime));
    expect(yield* Ref.get(testRuntime.starts)).toBe(2);
  }),
);

it.effect("replaces a cached server that already stopped before its watcher ran", () =>
  Effect.gen(function* () {
    const testRuntime = yield* makeRuntime;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const owner = yield* OpenCodeServerOwner.make({ binaryPath: "opencode" });
        expect(yield* owner.withServer((server) => Effect.succeed(server.url))).toBe(
          "http://127.0.0.1:4001",
        );
        yield* Ref.set(testRuntime.spawned[0]!.running, false);
        expect(yield* owner.withServer((server) => Effect.succeed(server.url))).toBe(
          "http://127.0.0.1:4002",
        );
        expect(yield* Ref.get(testRuntime.closes)).toBe(1);
      }),
    ).pipe(Effect.provideService(OpenCodeRuntime, testRuntime.runtime));
  }),
);

it.effect("keeps a borrowed server alive past the idle TTL and lends it again", () =>
  Effect.gen(function* () {
    const testRuntime = yield* makeRuntime;
    const release = yield* Deferred.make<void>();
    yield* Effect.scoped(
      Effect.gen(function* () {
        const owner = yield* OpenCodeServerOwner.make({ binaryPath: "opencode" });
        // A single forked fiber is only scheduled once the test clock is nudged,
        // so the holder is forked as part of a concurrent batch.
        const holder = yield* Effect.all(
          [
            owner.withServer(() => Deferred.await(release).pipe(Effect.andThen(Effect.never))),
            owner.withServer((server) => Effect.succeed(server.url)),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.forkChild);
        yield* Deferred.await(testRuntime.started);
        yield* TestClock.adjust(Duration.seconds(31));
        expect(yield* owner.withServer((server) => Effect.succeed(server.url))).toBe(
          "http://127.0.0.1:4001",
        );
        expect(yield* Ref.get(testRuntime.closes)).toBe(0);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.interrupt(holder);
      }),
    ).pipe(Effect.provideService(OpenCodeRuntime, testRuntime.runtime));
    expect(yield* Ref.get(testRuntime.starts)).toBe(1);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("closes the shared server when the owner scope shuts down", () =>
  Effect.gen(function* () {
    const testRuntime = yield* makeRuntime;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const owner = yield* OpenCodeServerOwner.make({ binaryPath: "opencode" });
        yield* owner.withServer((server) => Effect.succeed(server.url));
      }),
    ).pipe(Effect.provideService(OpenCodeRuntime, testRuntime.runtime));
    expect(yield* Ref.get(testRuntime.closes)).toBe(1);
  }),
);

it.effect("fails a start without caching a half-started server, then allows a retry", () =>
  Effect.gen(function* () {
    const starts = yield* Ref.make(0);
    const closes = yield* Ref.make(0);
    const runtime: OpenCodeRuntimeShape = {
      startOpenCodeServerProcess: () =>
        Effect.gen(function* () {
          const index = yield* Ref.updateAndGet(starts, (count) => count + 1);
          yield* Effect.addFinalizer(() => Ref.update(closes, (count) => count + 1));
          if (index === 1) {
            return yield* new OpenCodeRuntimeError({
              operation: "startOpenCodeServerProcess",
              detail: "start failed",
            });
          }
          return {
            url: "http://127.0.0.1:4002",
            isRunning: Effect.succeed(true),
            exitCode: Effect.never,
          };
        }),
      connectToOpenCodeServer: unusedRuntimeMethod,
      runOpenCodeCommand: unusedRuntimeMethod,
      createOpenCodeSdkClient: () => ({}) as never,
      loadOpenCodeInventory: unusedRuntimeMethod,
      loadOpenCodeSkills: unusedRuntimeMethod,
      loadOpenCodeSkillsForCwd: unusedRuntimeMethod,
      loadInventoryFromCli: unusedRuntimeMethod,
    };

    yield* Effect.scoped(
      Effect.gen(function* () {
        const owner = yield* OpenCodeServerOwner.make({ binaryPath: "opencode" });
        expect(
          Exit.isFailure(
            yield* Effect.exit(owner.withServer((server) => Effect.succeed(server.url))),
          ),
        ).toBe(true);
        expect(yield* owner.withServer((server) => Effect.succeed(server.url))).toBe(
          "http://127.0.0.1:4002",
        );
      }),
    ).pipe(Effect.provideService(OpenCodeRuntime, runtime));
    expect(yield* Ref.get(starts)).toBe(2);
    expect(yield* Ref.get(closes)).toBe(2);
  }),
);
