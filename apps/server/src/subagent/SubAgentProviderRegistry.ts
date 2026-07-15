import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ServerProvider } from "@t3tools/contracts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import type {
  SubAgentProviderInfo,
  SubAgentProviderFilter,
  SubAgentModelInfo,
} from "./SubAgentProviderInfo.ts";
import {
  getModelCostTier,
  getProviderCostTier,
  isSpawnableProvider,
  CONCURRENCY_LIMITS,
} from "./SubAgentProviderInfo.ts";

export interface SubAgentProviderRegistryShape {
  readonly listSpawnableProviders: (
    filter?: SubAgentProviderFilter,
  ) => Effect.Effect<ReadonlyArray<SubAgentProviderInfo>>;

  readonly getProviderInfo: (
    instanceId: string,
  ) => Effect.Effect<SubAgentProviderInfo | null>;
}

export class SubAgentProviderRegistry extends Context.Service<
  SubAgentProviderRegistry,
  SubAgentProviderRegistryShape
>()("t3/subagent/SubAgentProviderRegistry") {}

const makeSubAgentProviderRegistry = Effect.gen(function* () {
  const providerRegistry = yield* ProviderRegistry;

  function mapToSubAgentProviderInfo(provider: ServerProvider): SubAgentProviderInfo {
    const costTier = getProviderCostTier(provider.driver);

    const models: SubAgentModelInfo[] = provider.models.map((model) => {
      const modelCostTier = getModelCostTier(model.slug);
      return {
        slug: model.slug,
        displayName: model.displayName ?? model.slug,
        contextWindow: model.capabilities?.contextWindow,
        supportedOptions: model.capabilities?.optionDescriptors?.map((d) => d.id) ?? [],
        costTier: modelCostTier,
        concurrencyLimit: CONCURRENCY_LIMITS[modelCostTier],
      };
    });

    const status: SubAgentProviderInfo["status"] =
      provider.status === "available"
        ? "available"
        : provider.status === "disabled"
          ? "disabled"
          : provider.status === "error"
            ? "error"
            : "unavailable";

    const spawnable = isSpawnableProvider(
      status,
      costTier,
      true, // excludeApiCredits
    );

    return {
      instanceId: provider.instanceId,
      driver: provider.driver,
      displayName: provider.displayName ?? provider.driver,
      status,
      spawnable,
      capabilities: {
        supportsSubAgents: true,
        maxConcurrentSubAgents: CONCURRENCY_LIMITS.global,
      },
      models,
      costTier,
    };
  }

  const listSpawnableProviders: SubAgentProviderRegistryShape["listSpawnableProviders"] = (
    filter,
  ) =>
    Effect.gen(function* () {
      const providers = yield* providerRegistry.getProviders;
      let mapped = providers.map(mapToSubAgentProviderInfo);

      // Apply filters
      if (filter?.excludeApiCredits !== false) {
        mapped = mapped.filter((p) => p.costTier !== "api-credits");
      }
      if (filter?.requireSubscription) {
        mapped = mapped.filter((p) => p.costTier === "subscription");
      }
      if (filter?.requireAvailable !== false) {
        mapped = mapped.filter((p) => p.spawnable);
      }
      if (filter?.driverKinds && filter.driverKinds.length > 0) {
        const driverSet = new Set(filter.driverKinds);
        mapped = mapped.filter((p) => driverSet.has(p.driver));
      }

      return mapped;
    });

  const getProviderInfo: SubAgentProviderRegistryShape["getProviderInfo"] = (instanceId) =>
    Effect.gen(function* () {
      const providers = yield* providerRegistry.getProviders;
      const provider = providers.find((p) => p.instanceId === instanceId);
      return provider ? mapToSubAgentProviderInfo(provider) : null;
    });

  return SubAgentProviderRegistry.of({
    listSpawnableProviders,
    getProviderInfo,
  });
});

export const SubAgentProviderRegistryLive = Layer.effect(
  SubAgentProviderRegistry,
  makeSubAgentProviderRegistry,
).pipe(Layer.provide(ProviderRegistry.Default));
