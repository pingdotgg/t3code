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

  it.effect("stays within 256 rows and 32 MiB after a burst of saves ends", () =>
    Effect.gen(function* () {
      const store = (yield* EnvironmentQueryStore)!;
      const environmentId = EnvironmentId.make("query-bounded");
      const keys = Array.from({ length: 300 }, (_, index) => `row-${index}`);
      for (const key of keys) {
        yield* store.save(environmentId, key, key);
        yield* TestClock.adjust("1 millis");
      }
      const answer = "x".repeat(4 * 1024 * 1024);
      const large = Array.from({ length: 9 }, (_, index) => `large-${index}`);
      for (const key of large) {
        yield* store.save(environmentId, key, answer);
        yield* TestClock.adjust("1 millis");
      }

      const kept = yield* Effect.forEach([...keys, ...large], (key) =>
        store.load(environmentId, key),
      );
      const payloads = kept.filter(Option.isSome).map((stored) => stored.value);
      expect(payloads.length).toBeLessThanOrEqual(256);
      expect(payloads.reduce((total, payload) => total + payload.length, 0)).toBeLessThanOrEqual(
        32 * 1024 * 1024,
      );
      expect(kept[0]).toEqual(Option.none());
      expect(kept.at(-1)).toEqual(Option.some(answer));
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
