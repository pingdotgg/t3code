import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { TestClock } from "effect/testing";

import {
  makeProviderTextDeltaCoalescer,
  type ProviderTextDeltaUpdate,
} from "./ProviderTextDeltaCoalescer.ts";

/** A coalescer that records what it is asked to project. */
const recorder = Effect.fnUntraced(function* (flushIntervalMs = 50) {
  const emitted: Array<ProviderTextDeltaUpdate> = [];
  const coalescer = yield* makeProviderTextDeltaCoalescer({
    flushIntervalMs,
    emit: (update) => Effect.sync(() => emitted.push(update)),
  });
  return { coalescer, emitted };
});

describe("ProviderTextDeltaCoalescer", () => {
  it.effect("replaces what append buffered when setText carries a snapshot", () =>
    Effect.gen(function* () {
      const { coalescer, emitted } = yield* recorder();
      for (const delta of ["a", "b", "c"]) {
        yield* coalescer.append({ turnId: "turn", itemId: "item", delta });
      }
      // Every adapter but this coalescer keeps its own authoritative text and
      // discards what the buffer holds, so this is the only place replace
      // semantics are observable at all.
      yield* coalescer.setText({ turnId: "turn", itemId: "item", text: "snapshot" });
      yield* coalescer.flushPendingTurn("turn");
      assert.deepEqual(emitted, [
        { turnId: "turn", itemId: "item", text: "snapshot", completed: false },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("projects a burst of deltas once, on the flush interval", () =>
    Effect.gen(function* () {
      const { coalescer, emitted } = yield* recorder();
      for (const delta of ["a", "b", "c"]) {
        yield* coalescer.append({ turnId: "turn", itemId: "item", delta });
      }
      yield* TestClock.adjust(49);
      assert.lengthOf(emitted, 0);
      yield* TestClock.adjust(1);
      assert.deepEqual(emitted, [
        { turnId: "turn", itemId: "item", text: "abc", completed: false },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps an appended delta out of a burst nothing else dirties", () =>
    Effect.gen(function* () {
      const { coalescer, emitted } = yield* recorder();
      yield* coalescer.append({ turnId: "turn", itemId: "first", delta: "a" });
      yield* coalescer.append({ turnId: "turn", itemId: "second", delta: "b" });
      yield* TestClock.adjust(50);
      yield* coalescer.flushPendingTurn("other");
      assert.lengthOf(emitted, 2);
      yield* TestClock.adjust(50);
      // The interval elapsed with nothing new to project, so nothing repeats.
      assert.lengthOf(emitted, 2);
    }).pipe(Effect.scoped),
  );
});
