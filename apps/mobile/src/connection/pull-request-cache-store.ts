import { EnvironmentQueryStore } from "@t3tools/client-runtime/state/query-persistence";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { MobileDatabase } from "../persistence/mobile-database";

export const layer = Layer.effect(
  EnvironmentQueryStore,
  Effect.gen(function* () {
    const database = yield* MobileDatabase;
    return {
      load: (environmentId, key) =>
        database
          .loadCache(environmentId, "pull-request", `v1:${key}`)
          .pipe(Effect.catch(() => Effect.succeedNone)),
      save: (environmentId, key, payload) =>
        database
          .saveCache(environmentId, "pull-request", `v1:${key}`, 1, payload)
          .pipe(Effect.catch(() => Effect.logWarning("Offline query database save failed"))),
    } satisfies NonNullable<typeof EnvironmentQueryStore.Service>;
  }),
);
