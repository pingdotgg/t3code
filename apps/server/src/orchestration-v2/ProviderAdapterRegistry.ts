import { ProviderKind } from "@t3tools/contracts";
import { Context, Effect, Layer, Schema } from "effect";

import { ProviderAdapterV2, type ProviderAdapterV2Shape } from "./ProviderAdapter.ts";

export class ProviderAdapterRegistryLookupError extends Schema.TaggedErrorClass<ProviderAdapterRegistryLookupError>()(
  "ProviderAdapterRegistryLookupError",
  {
    provider: ProviderKind,
  },
) {
  override get message(): string {
    return `No orchestration provider adapter is registered for ${this.provider}.`;
  }
}

export const ProviderAdapterRegistryV2Error = Schema.Union([ProviderAdapterRegistryLookupError]);
export type ProviderAdapterRegistryV2Error = typeof ProviderAdapterRegistryV2Error.Type;

export interface ProviderAdapterRegistryV2Shape {
  readonly get: (
    provider: ProviderKind,
  ) => Effect.Effect<ProviderAdapterV2Shape, ProviderAdapterRegistryV2Error>;
  readonly list: () => Effect.Effect<ReadonlyArray<ProviderKind>>;
}

export class ProviderAdapterRegistryV2 extends Context.Service<
  ProviderAdapterRegistryV2,
  ProviderAdapterRegistryV2Shape
>()("t3/orchestration-v2/ProviderAdapterRegistry") {}

export function makeLayer(
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

export function makeSingleLayer(
  adapter: ProviderAdapterV2Shape,
): Layer.Layer<ProviderAdapterRegistryV2> {
  return makeLayer([adapter]);
}

export const layerFromProviderAdapter: Layer.Layer<
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
