import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import * as ReviewWatcher from "./ReviewWatcher.ts";

describe("ReviewWatcher", () => {
  it.effect("signals readiness before reporting subsequent workspace changes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-watcher-" });
      const ignoredRoot = `${root}/ignored`;
      yield* fs.makeDirectory(ignoredRoot);
      const ready = yield* Deferred.make<void>();
      const watcher = yield* ReviewWatcher.ReviewWatcher;
      const fiber = yield* watcher.watch([{ path: root, ignoredPaths: [ignoredRoot] }]).pipe(
        Stream.tap((event) =>
          event._tag === "Ready" ? Deferred.succeed(ready, undefined) : Effect.void,
        ),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* Deferred.await(ready);
      yield* fs.writeFileString(`${ignoredRoot}/ignored.txt`, "ignored");
      yield* fs.writeFileString(`${root}/changed.txt`, "changed");
      const events = Array.from(yield* Fiber.join(fiber));

      assert.deepStrictEqual(
        events.map((event) => event._tag),
        ["Ready", "Update"],
      );
      const update = events[1];
      assert.isDefined(update);
      assert.strictEqual(update._tag, "Update");
      if (update._tag === "Update") {
        assert.strictEqual(update.path, `${root}/changed.txt`);
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.timeout("5 seconds")),
  );

  it.effect("isolates concurrent workspace subscriptions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const firstRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-watcher-a-" });
      const secondRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-watcher-b-" });
      const firstReady = yield* Deferred.make<void>();
      const secondReady = yield* Deferred.make<void>();
      const secondFinished = yield* Deferred.make<void>();
      const watcher = yield* ReviewWatcher.ReviewWatcher;
      const firstFiber = yield* watcher.watch([{ path: firstRoot, ignoredPaths: [] }]).pipe(
        Stream.tap((event) =>
          event._tag === "Ready" ? Deferred.succeed(firstReady, undefined) : Effect.void,
        ),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      const secondEvents: ReviewWatcher.ReviewWatchEvent[] = [];
      const secondFiber = yield* watcher.watch([{ path: secondRoot, ignoredPaths: [] }]).pipe(
        Stream.tap((event) =>
          Effect.gen(function* () {
            secondEvents.push(event);
            if (event._tag === "Ready") {
              yield* Deferred.succeed(secondReady, undefined);
            } else if (event.path === `${secondRoot}/third.txt`) {
              yield* Deferred.succeed(secondFinished, undefined);
            }
          }),
        ),
        Stream.runDrain,
        Effect.forkChild,
      );

      yield* Effect.all([Deferred.await(firstReady), Deferred.await(secondReady)]);
      yield* fs.writeFileString(`${firstRoot}/first.txt`, "first");
      yield* fs.writeFileString(`${secondRoot}/second.txt`, "second");
      const firstEvents = Array.from(yield* Fiber.join(firstFiber));
      yield* fs.writeFileString(`${secondRoot}/third.txt`, "third");
      yield* Deferred.await(secondFinished);
      yield* Fiber.interrupt(secondFiber);

      assert.deepStrictEqual(
        firstEvents.map((event) => event._tag),
        ["Ready", "Update"],
      );
      assert.deepStrictEqual(
        [
          ...new Set(
            secondEvents.filter((event) => event._tag === "Update").map((event) => event.path),
          ),
        ].sort(),
        [`${secondRoot}/second.txt`, `${secondRoot}/third.txt`],
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.timeout("5 seconds")),
  );
});
