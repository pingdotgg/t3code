import { Persistence } from "@t3tools/client-runtime/platform";
import { EnvironmentQueryStore } from "@t3tools/client-runtime/state/query-persistence";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { TestClock } from "effect/testing";

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

  it.effect("evicts the oldest answers past 256 rows", () =>
    Effect.gen(function* () {
      const store = (yield* EnvironmentQueryStore)!;
      const environmentId = EnvironmentId.make("query-bounded");
      yield* store.save(environmentId, "oldest", "0");
      yield* TestClock.adjust("1 millis");
      for (let index = 0; index < 256; index += 1) {
        yield* store.save(environmentId, `row-${index}`, String(index));
      }
      yield* TestClock.adjust("10 seconds");
      yield* store.save(environmentId, "newest", "new");
      expect(yield* store.load(environmentId, "oldest")).toEqual(Option.none());
      expect(yield* store.load(environmentId, "newest")).toEqual(Option.some("new"));
    }).pipe(Effect.provide(ConnectionStorage.layer)),
  );

  it.effect("drops the older copy when an answer grows too large to keep", () =>
    Effect.gen(function* () {
      const store = (yield* EnvironmentQueryStore)!;
      const environmentId = EnvironmentId.make("query-oversize");
      yield* store.save(environmentId, "diff", "small");
      yield* store.save(environmentId, "diff", "x".repeat(4 * 1024 * 1024 + 1));
      expect(yield* store.load(environmentId, "diff")).toEqual(Option.none());
    }).pipe(Effect.provide(ConnectionStorage.layer)),
  );
});
