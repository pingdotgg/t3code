import type { ProviderKind } from "@t3tools/contracts";
import { Effect, Layer } from "effect";

import { ProviderAdapterV2, type ProviderAdapterV2Shape } from "../Services/ProviderAdapter.ts";
import {
  ProviderAdapterRegistryLookupError,
  ProviderAdapterRegistryV2,
  type ProviderAdapterRegistryV2Shape,
} from "../Services/ProviderAdapterRegistry.ts";

export function makeProviderAdapterRegistryV2Layer(
  adapters: ReadonlyArray<ProviderAdapterV2Shape>,
): Layer.Layer<ProviderAdapterRegistryV2> {
  return Layer.succeed(
    ProviderAdapterRegistryV2,
    ProviderAdapterRegistryV2.of({
      get: (provider) =>
        Effect.gen(function* () {
          const adapter = adapters.find((candidate) => candidate.provider === provider);
          if (!adapter) {
            return yield* new ProviderAdapterRegistryLookupError({ provider });
          }
          return adapter;
        }),
      list: () => Effect.succeed(adapters.map((adapter) => adapter.provider as ProviderKind)),
    } satisfies ProviderAdapterRegistryV2Shape),
  );
}

export function makeSingleProviderAdapterRegistryV2Layer(
  adapter: ProviderAdapterV2Shape,
): Layer.Layer<ProviderAdapterRegistryV2> {
  return makeProviderAdapterRegistryV2Layer([adapter]);
}

export const ProviderAdapterRegistryV2FromSingleAdapterLayer: Layer.Layer<
  ProviderAdapterRegistryV2,
  never,
  ProviderAdapterV2
> = Layer.effect(
  ProviderAdapterRegistryV2,
  Effect.gen(function* () {
    const adapter = yield* ProviderAdapterV2;
    return ProviderAdapterRegistryV2.of({
      get: (provider) =>
        adapter.provider === provider
          ? Effect.succeed(adapter)
          : Effect.fail(new ProviderAdapterRegistryLookupError({ provider })),
      list: () => Effect.succeed([adapter.provider]),
    } satisfies ProviderAdapterRegistryV2Shape);
  }),
);
