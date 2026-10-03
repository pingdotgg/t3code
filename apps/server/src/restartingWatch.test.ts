import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import { keepWatching } from "./restartingWatch.ts";

it.effect("restarts a failed watcher and revalidates before it watches again", () =>
  Effect.gen(function* () {
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    const record = (event: string) => Ref.update(events, (all) => [...all, event]);
    const secondWatchStarted = yield* Deferred.make<void>();
    const watchStarts = yield* Ref.make(0);
    const watch = Ref.updateAndGet(watchStarts, (count) => count + 1).pipe(
      Effect.flatMap((count) =>
        count === 1
          ? record("watch").pipe(Effect.andThen(Effect.fail("watch error")))
          : record("watch").pipe(
              Effect.andThen(Deferred.succeed(secondWatchStarted, undefined)),
              Effect.andThen(Effect.never),
            ),
      ),
    );

    const fiber = yield* keepWatching({
      label: "Test",
      watch,
      revalidate: record("revalidate"),
    }).pipe(Effect.forkChild);
    yield* TestClock.adjust("30 seconds");
    yield* Deferred.await(secondWatchStarted);

    assert.deepStrictEqual(yield* Ref.get(events), ["watch", "revalidate", "watch"]);
    yield* Fiber.interrupt(fiber);
  }),
);
