import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { PullRequestOperationError } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore";
import * as Persistence from "effect/unstable/persistence/Persistence";
import * as PullRequestReadCache from "./PullRequestReadCache.ts";

const cacheLayer = (directory: string) =>
  PullRequestReadCache.make.pipe(
    Effect.provide(
      Persistence.layerKvs.pipe(Layer.provideMerge(KeyValueStore.layerFileSystem(directory))),
    ),
  );

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
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const invalidate = yield* cache.invalidate.pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(read);
      yield* Fiber.join(invalidate);
      const restarted = yield* cacheLayer(directory);
      assert.strictEqual(yield* restarted.get("summary", Effect.succeed("new")), "new");
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
});
