import { describe, expect, it } from "@effect/vitest";
import type { ServerProviderModel } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import { makeProviderModelDiscoveryCache } from "./ProviderModelDiscoveryCache.ts";

describe("ProviderModelDiscoveryCache", () => {
  it.effect("records empty model lists so stale discovered models can be cleared", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cache = yield* makeProviderModelDiscoveryCache();
        const model = {
          slug: "devin-model",
          name: "Devin Model",
          isCustom: false,
          capabilities: null,
        } satisfies ServerProviderModel;

        yield* cache.recordModels([model]);
        expect(yield* cache.getModels).toEqual([model]);

        yield* cache.recordModels([]);

        expect(yield* cache.getModels).toEqual([]);
      }),
    ),
  );

  it.effect("primes models without triggering a provider refresh", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cache = yield* makeProviderModelDiscoveryCache();
        let refreshCount = 0;
        const model = {
          slug: "devin-model",
          name: "Devin Model",
          isCustom: false,
          capabilities: null,
        } satisfies ServerProviderModel;

        yield* cache.setRefresh(
          Effect.sync(() => {
            refreshCount += 1;
          }),
        );
        yield* cache.primeModels([model]);

        expect(yield* cache.getModels).toEqual([model]);
        expect(refreshCount).toBe(0);
      }),
    ),
  );

  it.effect("schedules a provider refresh when real session discovery records models", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cache = yield* makeProviderModelDiscoveryCache();
        const refreshed = yield* Deferred.make<void>();
        const model = {
          slug: "devin-model",
          name: "Devin Model",
          isCustom: false,
          capabilities: null,
        } satisfies ServerProviderModel;

        yield* cache.setRefresh(Deferred.succeed(refreshed, undefined).pipe(Effect.asVoid));
        yield* cache.recordModels([model]);
        yield* Deferred.await(refreshed);

        expect(yield* cache.getModels).toEqual([model]);
      }),
    ),
  );
});
