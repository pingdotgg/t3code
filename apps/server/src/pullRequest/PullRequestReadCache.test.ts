import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { PullRequestOperationError } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as TestClock from "effect/testing/TestClock";
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore";
import * as PullRequestReadCache from "./PullRequestReadCache.ts";

const cacheLayer = (directory: string) =>
  PullRequestReadCache.make.pipe(Effect.provide(KeyValueStore.layerFileSystem(directory)));

it.layer(NodeServices.layer)("PR filesystem cache", (it) => {
  it.effect("reuses files after restart and respects the original expiry", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pr-cache-" });
      let reads = 0;
      const lookup = Effect.sync(() => String(++reads));
      const first = yield* cacheLayer(directory);
      const key = "long/repository/key".repeat(100);
      assert.strictEqual(yield* first.get(key, lookup), "1");
      yield* TestClock.adjust("59 seconds");
      const restarted = yield* cacheLayer(directory);
      assert.strictEqual(yield* restarted.get(key, lookup), "1");
      yield* TestClock.adjust("1 second");
      assert.strictEqual(yield* restarted.get(key, lookup), "2");
      assert.strictEqual(reads, 2);
      assert.strictEqual((yield* fs.readDirectory(directory)).length, 1);
    }),
  );

  it.effect("clears in-flight reads before a new service can reuse them", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pr-cache-" });
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const cache = yield* cacheLayer(directory);
      const read = yield* cache
        .get(
          "summary",
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as("old"),
          ),
          ["pr"],
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const invalidate = yield* cache
        .invalidate("pr")
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(read);
      yield* Fiber.join(invalidate);
      const restarted = yield* cacheLayer(directory);
      assert.strictEqual(yield* restarted.get("summary", Effect.succeed("new"), ["pr"]), "new");
    }),
  );

  it.effect("invalidates only the changed scope across restarts and coalesces its next reads", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pr-cache-" });
      let reads = 0;
      const lookup = Effect.sync(() => String(++reads));
      const cache = yield* cacheLayer(directory);
      yield* cache.get("first", lookup, ["project", "pr-1"]);
      yield* cache.get("second", lookup, ["project", "pr-2"]);
      yield* cache.get("third", lookup, ["other-project", "pr-3"]);
      yield* cache.invalidate("pr-1");
      const restarted = yield* cacheLayer(directory);
      const answers = yield* Effect.all(
        Array.from({ length: 10 }, () => restarted.get("first", lookup, ["project", "pr-1"])),
        { concurrency: 10 },
      );
      assert.deepStrictEqual(answers, Array(10).fill("4"));
      assert.strictEqual(yield* restarted.get("second", lookup, ["project", "pr-2"]), "2");
      yield* restarted.invalidate("project");
      const again = yield* cacheLayer(directory);
      assert.strictEqual(yield* again.get("second", lookup, ["project", "pr-2"]), "5");
      assert.strictEqual(yield* again.get("third", lookup, ["other-project", "pr-3"]), "3");
      assert.strictEqual(reads, 5);
      const files = (yield* fs.readDirectory(directory)).length;
      for (let index = 0; index < 3; index++) {
        yield* again.invalidate("pr-1");
        yield* again.get("first", lookup, ["project", "pr-1"]);
      }
      assert.strictEqual((yield* fs.readDirectory(directory)).length, files);
    }),
  );

  it.effect("shares a pending refresh without blocking an unrelated cached PR", () =>
    Effect.gen(function* () {
      const cache = yield* PullRequestReadCache.make;
      yield* cache.get("first", Effect.succeed("old"), ["pr-1"]);
      yield* cache.get("second", Effect.succeed("warm"), ["pr-2"]);
      yield* cache.invalidate("pr-1");
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let reads = 0;
      const refresh = cache.get(
        "first",
        Effect.gen(function* () {
          reads++;
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
          return "fresh";
        }),
        ["pr-1"],
      );
      const pending = yield* Effect.all(
        Array.from({ length: 10 }, () => refresh),
        {
          concurrency: 10,
        },
      ).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      assert.strictEqual(yield* cache.get("second", Effect.die("cache miss"), ["pr-2"]), "warm");
      yield* Deferred.succeed(release, undefined);
      assert.deepStrictEqual(yield* Fiber.join(pending), Array(10).fill("fresh"));
      assert.strictEqual(reads, 1);
    }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  );

  it.effect("compacts expired scope records without discarding fresh PR data", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pr-cache-" });
      const cache = yield* cacheLayer(directory);
      yield* cache.get("summary", Effect.succeed("old"), ["pr"]);
      yield* cache.invalidate("pr");
      for (let index = 0; index < 100; index++) yield* cache.invalidate(`pr-${index}`);
      assert.strictEqual((yield* fs.readDirectory(directory)).length, 2);
      const before = (yield* fs.stat(`${directory}/revisions`)).size;
      yield* TestClock.adjust("59 seconds");
      assert.strictEqual(yield* cache.get("summary", Effect.succeed("fresh"), ["pr"]), "fresh");
      yield* TestClock.adjust("1 second");
      yield* cache.invalidate("other-pr");
      assert.isTrue((yield* fs.stat(`${directory}/revisions`)).size < before);
      const restarted = yield* cacheLayer(directory);
      assert.strictEqual(
        yield* restarted.get("summary", Effect.die("cache miss"), ["pr"]),
        "fresh",
      );
    }),
  );

  it.effect("does not persist failed GitHub reads", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pr-cache-" });
      const cache = yield* cacheLayer(directory);
      const error = new PullRequestOperationError({ operation: "summary", detail: "unavailable" });
      yield* cache.get("summary", Effect.fail(error)).pipe(Effect.flip);
      const restarted = yield* cacheLayer(directory);
      assert.strictEqual(yield* restarted.get("summary", Effect.succeed("recovered")), "recovered");
    }),
  );

  it.effect("resumes caching after a failed scope read", () =>
    Effect.gen(function* () {
      const backing = yield* KeyValueStore.KeyValueStore;
      let fail = true;
      let reads = 0;
      const cache = yield* PullRequestReadCache.make.pipe(
        Effect.provideService(KeyValueStore.KeyValueStore, {
          ...backing,
          get: (key) =>
            Effect.suspend(() => {
              if (!fail) return backing.get(key);
              fail = false;
              return Effect.fail(
                new KeyValueStore.KeyValueStoreError({ method: "get", message: "unavailable" }),
              );
            }),
        }),
      );
      const read = cache.get(
        "summary",
        Effect.sync(() => String(++reads)),
        ["pr"],
      );
      assert.strictEqual(yield* read, "1");
      assert.strictEqual(yield* read, "2");
      assert.strictEqual(yield* read, "2");
    }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  );

  it.effect("cancels abandoned reads without blocking invalidation", () =>
    Effect.gen(function* () {
      const cache = yield* PullRequestReadCache.make;
      const started = yield* Deferred.make<void>();
      const read = yield* cache
        .get("summary", Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)), [
          "pr",
        ])
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(read);
      yield* cache.invalidate("pr");
      assert.strictEqual(yield* cache.get("summary", Effect.succeed("fresh"), ["pr"]), "fresh");
    }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  );

  it.effect(
    "finishes the in-memory revision update when invalidation is canceled after writing",
    () =>
      Effect.gen(function* () {
        const backing = yield* KeyValueStore.KeyValueStore;
        const written = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const cache = yield* PullRequestReadCache.make.pipe(
          Effect.provideService(KeyValueStore.KeyValueStore, {
            ...backing,
            set: (key, value) =>
              backing
                .set(key, value)
                .pipe(
                  Effect.andThen(
                    key === "revisions"
                      ? Deferred.succeed(written, undefined).pipe(
                          Effect.andThen(Deferred.await(release)),
                        )
                      : Effect.void,
                  ),
                ),
          }),
        );
        yield* cache.get("summary", Effect.succeed("old"), ["pr"]);
        const invalidation = yield* cache.invalidate("pr").pipe(Effect.forkChild);
        yield* Deferred.await(written);
        const interrupt = yield* Fiber.interrupt(invalidation).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(interrupt);
        assert.strictEqual(yield* cache.get("summary", Effect.succeed("fresh"), ["pr"]), "fresh");
      }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  );
});
