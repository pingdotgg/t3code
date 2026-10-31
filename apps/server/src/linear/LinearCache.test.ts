import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { makeLinearCache } from "./LinearCache.ts";

describe("makeLinearCache", () => {
  it.effect("never keeps a load that was in flight when the cache was cleared", () =>
    Effect.gen(function* () {
      const cache = makeLinearCache<string>(10);
      const gate = yield* Deferred.make<void>();
      const before = yield* cache
        .get("teams", 60_000, Deferred.await(gate).pipe(Effect.as("workspace A")))
        .pipe(Effect.forkChild({ startImmediately: true }));

      yield* cache.clear;
      const after = yield* cache
        .get("teams", 60_000, Effect.succeed("workspace B"))
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(gate, undefined);

      assert.strictEqual((yield* Fiber.join(before)).value, "workspace A");
      assert.strictEqual((yield* Fiber.join(after)).value, "workspace B");
      const next = yield* cache.get("teams", 60_000, Effect.succeed("reloaded"));
      assert.strictEqual(next.value, "workspace B");
    }),
  );
});
