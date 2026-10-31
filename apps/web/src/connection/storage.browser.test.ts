import { Persistence } from "@t3tools/client-runtime/platform";
import { EnvironmentQueryStore } from "@t3tools/client-runtime/state/query-persistence";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as ConnectionStorage from "./storage";

describe("IndexedDB query cache", () => {
  it.effect("round trips per environment and clears with the environment", () =>
    Effect.gen(function* () {
      const store = (yield* EnvironmentQueryStore)!;
      const first = EnvironmentId.make("query-first");
      yield* store.save(first, "pr", "cached");
      expect(yield* store.load(first, "pr")).toEqual(Option.some("cached"));
      expect(yield* store.load(EnvironmentId.make("query-second"), "pr")).toEqual(Option.none());
      yield* (yield* Persistence.EnvironmentCacheStore).clear(first);
      expect(yield* store.load(first, "pr")).toEqual(Option.none());
    }).pipe(Effect.provide(ConnectionStorage.layer)),
  );

  it.effect("keeps the newest 256 responses per environment and skips oversized ones", () =>
    Effect.gen(function* () {
      const store = (yield* EnvironmentQueryStore)!;
      const bounded = EnvironmentId.make("query-bounded");
      const other = EnvironmentId.make("query-other");
      yield* store.save(other, "kept", "other");
      for (let index = 0; index <= 256; index++) {
        yield* TestClock.adjust(1);
        yield* store.save(bounded, `key-${index}`, `value-${index}`);
      }
      yield* store.save(bounded, "huge", "x".repeat(4 * 1024 * 1024 + 1));
      expect(yield* store.load(bounded, "key-0")).toEqual(Option.none());
      expect(yield* store.load(bounded, "key-1")).toEqual(Option.some("value-1"));
      expect(yield* store.load(bounded, "key-256")).toEqual(Option.some("value-256"));
      expect(yield* store.load(bounded, "huge")).toEqual(Option.none());
      expect(yield* store.load(other, "kept")).toEqual(Option.some("other"));
    }).pipe(Effect.provide(ConnectionStorage.layer)),
  );
});
