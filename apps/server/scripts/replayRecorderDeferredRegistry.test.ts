import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import { makeReplayRecorderDeferredRegistry } from "./replayRecorderDeferredRegistry.ts";

it.effect("atomically shares one deferred across concurrent get-or-create calls", () =>
  Effect.gen(function* () {
    const registry = yield* makeReplayRecorderDeferredRegistry();
    const deferreds = yield* Effect.all(
      Array.from({ length: 100 }, () => registry.getOrCreate("turn-1")),
      { concurrency: "unbounded" },
    );

    for (const deferred of deferreds) {
      assert.strictEqual(deferred, deferreds[0]);
    }

    yield* registry.succeed("turn-1");
    assert.isTrue(yield* Deferred.isDone(deferreds[0]!));
    yield* Effect.all(deferreds.map(Deferred.await), {
      concurrency: "unbounded",
      discard: true,
    });
  }),
);
