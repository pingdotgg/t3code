import { assert, describe, it } from "@effect/vitest";
import * as Cache from "effect/Cache";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";

import { getCached } from "./getCached.ts";

describe("getCached", () => {
  it.effect("a read that joins an abandoned lookup gets a fresh result", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const stopped = yield* Deferred.make<void>();
      let lookups = 0;
      const cache = yield* Cache.make<string, string>({
        capacity: 10,
        lookup: () =>
          ++lookups === 1
            ? // Like `gh`, the first lookup takes a moment to stop once interrupted.
              Effect.yieldNow.pipe(
                Effect.andThen(Deferred.succeed(started, undefined)),
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() => Deferred.await(stopped)),
              )
            : Effect.succeed("fresh"),
      });
      const first = yield* getCached(cache, "detail").pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(first).pipe(Effect.forkChild({ startImmediately: true }));
      const second = yield* getCached(cache, "detail").pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.succeed(stopped, undefined);

      assert.deepStrictEqual(yield* Fiber.await(second), Exit.succeed("fresh"));
      assert.strictEqual(lookups, 2);
    }),
  );

  it.effect("an interrupted read does not start another lookup", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let lookups = 0;
      const cache = yield* Cache.make<string, string>({
        capacity: 10,
        lookup: () => {
          lookups++;
          return Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));
        },
      });
      const read = yield* getCached(cache, "detail").pipe(Effect.forkChild);
      yield* Deferred.await(started);

      yield* Fiber.interrupt(read);

      assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(read)));
      assert.strictEqual(lookups, 1);
    }),
  );
});
