import { afterEach, describe, expect, it } from "vitest";
import { Deferred, Effect, Exit, Scope } from "effect";

import { makeDrainableWorker } from "./DrainableWorker";

describe("makeDrainableWorker", () => {
  let scope: Scope.Closeable | null = null;

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
  });

  it("waits for work enqueued during active processing before draining", async () => {
    scope = await Effect.runPromise(Scope.make("sequential"));

    const processed: string[] = [];
    const { worker, firstStarted, releaseFirst, secondStarted, releaseSecond } =
      await Effect.runPromise(
        Effect.gen(function* () {
          const firstStarted = yield* Deferred.make<void>();
          const releaseFirst = yield* Deferred.make<void>();
          const secondStarted = yield* Deferred.make<void>();
          const releaseSecond = yield* Deferred.make<void>();

          const worker = yield* makeDrainableWorker((item: string) =>
            Effect.gen(function* () {
              if (item === "first") {
                yield* Deferred.succeed(firstStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseFirst);
              }

              if (item === "second") {
                yield* Deferred.succeed(secondStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseSecond);
              }

              processed.push(item);
            }),
          );

          return {
            worker,
            firstStarted,
            releaseFirst,
            secondStarted,
            releaseSecond,
          };
        }).pipe(Scope.provide(scope)),
      );

    await Effect.runPromise(worker.enqueue("first"));
    await Effect.runPromise(Deferred.await(firstStarted));

    const drainPromise = Effect.runPromise(worker.drain);

    await Effect.runPromise(worker.enqueue("second"));
    await Effect.runPromise(Deferred.succeed(releaseFirst, undefined));
    await Effect.runPromise(Deferred.await(secondStarted));

    const earlyResult = await Promise.race([
      drainPromise.then(() => "resolved" as const),
      new Promise<"pending">((resolve) => {
        setTimeout(() => resolve("pending"), 20);
      }),
    ]);
    expect(earlyResult).toBe("pending");

    await Effect.runPromise(Deferred.succeed(releaseSecond, undefined));
    await drainPromise;

    expect(processed).toEqual(["first", "second"]);
  });
});
