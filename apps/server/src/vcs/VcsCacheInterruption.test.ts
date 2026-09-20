import { assert, it } from "@effect/vitest";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";

// Status and ref refreshes share cached lookups. A cancelled lookup must notify
// every consumer so the panel can finish its refresh and retry.
it.effect("notifies every cache consumer when a shared lookup is interrupted", () =>
  Effect.gen(function* () {
    const release = yield* Deferred.make<void>();
    let attempts = 0;
    const cache = yield* Cache.make({
      capacity: 1,
      lookup: (_cwd: string) =>
        Effect.suspend(() =>
          ++attempts === 1
            ? Deferred.await(release).pipe(Effect.andThen(Effect.interrupt))
            : Effect.succeed(42),
        ),
    });
    const first = yield* Cache.get(cache, "repo").pipe(
      Effect.exit,
      Effect.forkChild({ startImmediately: true }),
    );
    const second = yield* Cache.get(cache, "repo").pipe(
      Effect.exit,
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Deferred.succeed(release, undefined);
    for (const consumer of [first, second]) {
      const exit = yield* Fiber.join(consumer);
      assert.isTrue(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
    }
    assert.equal(attempts, 1);
    assert.equal(yield* Cache.get(cache, "repo"), 42);
    assert.equal(attempts, 2);
  }),
);
