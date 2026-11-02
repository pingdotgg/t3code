import { Persistence } from "@t3tools/client-runtime/platform";
import { EnvironmentQueryStore } from "@t3tools/client-runtime/state/query-persistence";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

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
});
