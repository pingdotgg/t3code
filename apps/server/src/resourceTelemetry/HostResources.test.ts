import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../config.ts";
import * as HostResources from "./HostResources.ts";

const TestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-host-resources-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTest = Effect.fn(function* (statfs: typeof HostResources.HostStorageStatFs.Service) {
  return yield* HostResources.make().pipe(
    Effect.provideService(HostResources.HostStorageStatFs, statfs),
    Effect.provideService(HostProcessPlatform, "win32"),
  );
});

describe("HostResources storage", () => {
  it.effect(
    "shares an uncancellable filesystem call across concurrent reads and timed-out retries",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const pending = Promise.withResolvers<{ blocks: bigint; bsize: bigint; bavail: bigint }>();
        let reads = 0;
        const service = yield* makeTest(
          HostResources.makeHostStorageStatFs(() => {
            reads++;
            Deferred.doneUnsafe(started, Effect.void);
            return pending.promise;
          }),
        );
        const clients = yield* Effect.all([service.readStorage, service.readStorage], {
          concurrency: "unbounded",
        }).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* TestClock.adjust("1 second");
        expect((yield* Fiber.join(clients)).map((reading) => reading.storage)).toEqual([
          null,
          null,
        ]);
        const retry = yield* service.readStorage.pipe(Effect.forkChild);
        yield* TestClock.adjust("1 second");
        expect((yield* Fiber.join(retry)).storage).toBeNull();
        expect(reads).toBe(1);

        pending.resolve({ blocks: 1000n, bsize: 4096n, bavail: 100n });
        yield* Effect.promise(() => pending.promise);
        expect((yield* service.readStorage).storage).toEqual({
          totalBytes: 4096000,
          availableBytes: 409600,
        });
        expect(reads).toBe(2);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("releases the in-flight sample after a filesystem rejection", () =>
    Effect.gen(function* () {
      let reads = 0;
      const service = yield* makeTest(
        HostResources.makeHostStorageStatFs(() => {
          reads++;
          return reads === 1
            ? Promise.reject(new Error("filesystem unavailable"))
            : Promise.resolve({ blocks: 1000n, bsize: 4096n, bavail: 100n });
        }),
      );
      expect((yield* service.readStorage).storage).toBeNull();
      expect((yield* service.readStorage).storage).toEqual({
        totalBytes: 4096000,
        availableBytes: 409600,
      });
      expect(reads).toBe(2);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("samples the configured data filesystem again on every explicit read", () =>
    Effect.gen(function* () {
      const { stateDir } = yield* ServerConfig;
      const paths: string[] = [];
      const service = yield* makeTest((path) =>
        Effect.sync(() => {
          paths.push(path);
          return { blocks: 1000n, bsize: 4096n, bavail: BigInt(paths.length) };
        }),
      );
      const first = yield* service.readStorage;
      expect(first).toEqual({
        sampledAt: 0,
        storage: { totalBytes: 4096000, availableBytes: 4096 },
      });
      yield* TestClock.adjust("1 milli");
      const refreshed = yield* service.readStorage;
      expect(refreshed).toEqual({
        sampledAt: 1,
        storage: { totalBytes: 4096000, availableBytes: 8192 },
      });
      expect(paths).toEqual([stateDir, stateDir]);
    }).pipe(Effect.provide(TestLayer)),
  );

  for (const { name, stats, storage } of [
    {
      name: "reports zero available bytes for a full filesystem",
      stats: { blocks: 1000n, bsize: 4096n, bavail: 0n },
      storage: { totalBytes: 4096000, availableBytes: 0 },
    },
    {
      name: "rejects an unknown zero capacity",
      stats: { blocks: 0n, bsize: 4096n, bavail: 0n },
      storage: null,
    },
    {
      name: "rejects negative available blocks",
      stats: { blocks: 1000n, bsize: 4096n, bavail: -1n },
      storage: null,
    },
    {
      name: "rejects available capacity above the total",
      stats: { blocks: 1000n, bsize: 4096n, bavail: 1001n },
      storage: null,
    },
    {
      name: "rejects nonpositive block size",
      stats: { blocks: -1000n, bsize: -4096n, bavail: -1n },
      storage: null,
    },
    {
      name: "rejects capacity exceeding safe integer precision",
      stats: { blocks: BigInt(Number.MAX_SAFE_INTEGER), bsize: 4096n, bavail: 0n },
      storage: null,
    },
  ]) {
    it.effect(name, () =>
      Effect.gen(function* () {
        const service = yield* makeTest(() => Effect.succeed(stats));
        expect((yield* service.readStorage).storage).toEqual(storage);
      }).pipe(Effect.provide(TestLayer)),
    );
  }

  it.effect("recovers from a filesystem failure on the next read", () =>
    Effect.gen(function* () {
      let reads = 0;
      const service = yield* makeTest(() =>
        Effect.suspend(() => {
          reads++;
          return reads === 1
            ? Effect.fail(new HostResources.HostStorageError({ cause: "filesystem unavailable" }))
            : Effect.succeed({ blocks: 1000n, bsize: 4096n, bavail: 100n });
        }),
      );
      expect((yield* service.readStorage).storage).toBeNull();
      expect((yield* service.readStorage).storage).toEqual({
        totalBytes: 4096000,
        availableBytes: 409600,
      });
      expect(reads).toBe(2);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("keeps cached load-balancing reads independent of a stuck storage request", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let storageReads = 0;
      const service = yield* makeTest(() =>
        Effect.gen(function* () {
          storageReads++;
          yield* Deferred.succeed(started, undefined);
          return yield* Effect.never;
        }),
      );
      const storage = yield* service.readStorage.pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const resources = yield* service.read.pipe(Effect.forkChild);
      yield* TestClock.adjust("200 millis");
      const first = yield* Fiber.join(resources);
      expect(first.sampledAt).toBe(200);
      expect(first.totalMemoryBytes).toBeGreaterThan(0);
      expect(yield* service.read).toEqual(first);
      expect(storageReads).toBe(1);
      yield* TestClock.adjust("800 millis");
      expect(yield* Fiber.join(storage)).toEqual({ sampledAt: 1000, storage: null });
    }).pipe(Effect.provide(TestLayer)),
  );
});
