import type { ServerProviderSubProvider } from "@t3tools/contracts";

export function getJcodeModelRoute(model: { readonly slug: string; readonly name: string }) {
  if (!model.slug.startsWith("jcode-route:")) return null;
  // JCode's opaque route IDs carry their model, provider and API method in the display name.
  const match = /^(.+?) \((.+), ([^,()]+)\)$/.exec(model.name);
  return match ? { name: match[1]!, provider: match[2]!, apiMethod: match[3]! } : null;
}

export function groupJcodeModelRoutes<Model>(
  models: ReadonlyArray<Model>,
  modelOf: (model: Model) => {
    readonly slug: string;
    readonly name: string;
    readonly instanceId: string;
  },
): ReadonlyArray<ReadonlyArray<Model>> {
  const groups: Model[][] = [];
  const routes = new Map<string, Model[]>();
  for (const model of models) {
    const info = modelOf(model);
    const route = getJcodeModelRoute(info);
    const key = route ? JSON.stringify([info.instanceId, route.name]) : null;
    const group = key === null ? undefined : routes.get(key);
    if (group) {
      group.push(model);
    } else {
      const next = [model];
      groups.push(next);
      if (key !== null) routes.set(key, next);
    }
  }
  return groups;
}

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
