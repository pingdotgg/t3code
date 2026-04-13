import { Effect, Layer } from "effect";

import { ProviderSessionRuntimeRepositoryLive } from "../persistence/Layers/ProviderSessionRuntime.ts";
import { ProviderUnsupportedError } from "../provider/Errors.ts";
import { makeProviderServiceLive } from "../provider/Layers/ProviderService.ts";
import { ProviderSessionDirectoryLive } from "../provider/Layers/ProviderSessionDirectory.ts";
import { ProviderAdapterRegistry } from "../provider/Services/ProviderAdapterRegistry.ts";
import { makePerfProviderAdapter } from "./PerfProviderAdapter.ts";

export const PerfProviderLayerLive = Layer.unwrap(
  Effect.gen(function* () {
    const providerSessionDirectoryLayer = ProviderSessionDirectoryLive.pipe(
      Layer.provide(ProviderSessionRuntimeRepositoryLive),
    );
    const adapter = yield* makePerfProviderAdapter;
    const adapterRegistryLayer = Layer.succeed(ProviderAdapterRegistry, {
      getByProvider: (provider) =>
        provider === adapter.provider
          ? Effect.succeed(adapter)
          : Effect.fail(new ProviderUnsupportedError({ provider })),
      listProviders: () => Effect.succeed([adapter.provider]),
    } as typeof ProviderAdapterRegistry.Service);

    return makeProviderServiceLive().pipe(
      Layer.provide(adapterRegistryLayer),
      Layer.provide(providerSessionDirectoryLayer),
    );
  }),
);
