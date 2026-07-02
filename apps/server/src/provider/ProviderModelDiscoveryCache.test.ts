import { describe, expect, it } from "@effect/vitest";
import type { ServerProviderModel } from "@t3tools/contracts";
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
});
