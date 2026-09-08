import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
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
  it.effect("samples the configured data filesystem and shares the cache across clients", () =>
    Effect.gen(function* () {
      const { stateDir } = yield* ServerConfig;
      const paths: string[] = [];
      const service = yield* makeTest((path) =>
        Effect.sync(() => {
          paths.push(path);
          return { blocks: 1000n, bsize: 4096n, bavail: BigInt(paths.length) };
        }),
      );
      const clients = yield* Effect.all([service.read, service.read], {
        concurrency: "unbounded",
      }).pipe(Effect.forkChild);
      yield* TestClock.adjust("200 millis");
      const [first, second] = yield* Fiber.join(clients);
      expect(first.storage).toEqual({ totalBytes: 4096000, availableBytes: 4096 });
      expect(second).toEqual(first);
      expect(yield* service.read).toEqual(first);
      expect(paths).toEqual([stateDir]);

      yield* TestClock.adjust("5 seconds");
      const refreshed = yield* service.read.pipe(Effect.forkChild);
      yield* TestClock.adjust("200 millis");
      const next = yield* Fiber.join(refreshed);
      expect(next.storage).toEqual({ totalBytes: 4096000, availableBytes: 8192 });
      expect(next.sampledAt).toBeGreaterThan(first.sampledAt);
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
        const reading = yield* service.read.pipe(Effect.forkChild);
        yield* TestClock.adjust("200 millis");
        expect((yield* Fiber.join(reading)).storage).toEqual(storage);
      }).pipe(Effect.provide(TestLayer)),
    );
  }

  it.effect("keeps CPU and memory usable after a storage failure and retries after expiry", () =>
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
      const reading = yield* service.read.pipe(Effect.forkChild);
      yield* TestClock.adjust("200 millis");
      const failed = yield* Fiber.join(reading);
      expect(failed.storage).toBeNull();
      expect(failed.cpuCount).toBeGreaterThan(0);
      expect(failed.totalMemoryBytes).toBeGreaterThan(0);
      expect(failed.availableMemoryBytes).toBeGreaterThanOrEqual(0);
      expect(yield* service.read).toEqual(failed);
      expect(reads).toBe(1);

      yield* TestClock.adjust("5 seconds");
      const retry = yield* service.read.pipe(Effect.forkChild);
      yield* TestClock.adjust("200 millis");
      expect((yield* Fiber.join(retry)).storage).toEqual({
        totalBytes: 4096000,
        availableBytes: 409600,
      });
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("bounds a stuck filesystem reading without failing host resources", () =>
    Effect.gen(function* () {
      const service = yield* makeTest(() => Effect.never);
      const reading = yield* service.read.pipe(Effect.forkChild);
      yield* TestClock.adjust("1200 millis");
      const result = yield* Fiber.join(reading);
      expect(result.storage).toBeNull();
      expect(result.sampledAt).toBe(1200);
      expect(result.totalMemoryBytes).toBeGreaterThan(0);
    }).pipe(Effect.provide(TestLayer)),
  );
});
