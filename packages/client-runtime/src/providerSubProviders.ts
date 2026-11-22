import type { ServerProviderSubProvider } from "@t3tools/contracts";

export interface SubProviderGroup<Model> {
  readonly subProvider: ServerProviderSubProvider;
  readonly models: ReadonlyArray<Model>;
}

/**
 * Splits a provider's models into the ones outside any sub-provider, such as
 * "Default", and one group per sub-provider in the provider's order. A
 * signed-out sub-provider keeps its group, with no models.
 */
export function groupModelsBySubProvider<Model>(
  models: ReadonlyArray<Model>,
  subProviders: ReadonlyArray<ServerProviderSubProvider>,
  subProviderOf: (model: Model) => string | undefined,
): {
  readonly ungrouped: ReadonlyArray<Model>;
  readonly groups: ReadonlyArray<SubProviderGroup<Model>>;
} {
  const names = new Set(subProviders.map((subProvider) => subProvider.name));
  return {
    ungrouped: models.filter((model) => !names.has(subProviderOf(model) ?? "")),
    groups: subProviders.map((subProvider) => ({
      subProvider,
      models: models.filter((model) => subProviderOf(model) === subProvider.name),
    })),
  };
}
