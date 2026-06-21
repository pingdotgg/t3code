import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";

import { makeBoundedRequestCache } from "./ProviderSkillsLister.ts";

describe("makeBoundedRequestCache", () => {
  it.effect("coalesces concurrent requests for the same key", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const release = yield* Deferred.make<void>();
      const requests = yield* makeBoundedRequestCache({
        capacity: 8,
        concurrency: 2,
        timeToLive: "1 second",
        lookup: (key: string) =>
          Ref.update(calls, (count) => count + 1).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(`value:${key}`),
          ),
      });

      const first = yield* Effect.forkChild(requests.get("repo"));
      const second = yield* Effect.forkChild(requests.get("repo"));
      yield* Effect.yieldNow;
      expect(yield* Ref.get(calls)).toBe(1);

      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(first)).toBe("value:repo");
      expect(yield* Fiber.join(second)).toBe("value:repo");
      expect(yield* Ref.get(calls)).toBe(1);
    }),
  );

  it.effect("bounds concurrent lookups across different keys", () =>
    Effect.gen(function* () {
      const active = yield* Ref.make(0);
      const maxActive = yield* Ref.make(0);
      const release = yield* Deferred.make<void>();
      const requests = yield* makeBoundedRequestCache({
        capacity: 8,
        concurrency: 2,
        timeToLive: "1 second",
        lookup: (key: string) =>
          Effect.acquireUseRelease(
            Ref.updateAndGet(active, (count) => count + 1).pipe(
              Effect.tap((count) => Ref.update(maxActive, (maximum) => Math.max(maximum, count))),
            ),
            () => Deferred.await(release).pipe(Effect.as(key)),
            () => Ref.update(active, (count) => count - 1),
          ),
      });

      const fibers = yield* Effect.forEach(["one", "two", "three"], requests.get, {
        concurrency: "unbounded",
        discard: false,
      }).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      expect(yield* Ref.get(maxActive)).toBe(2);

      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(fibers)).toEqual(["one", "two", "three"]);
    }),
  );
});
