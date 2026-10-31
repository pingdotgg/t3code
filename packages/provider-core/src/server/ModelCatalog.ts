import type {
  ModelCapabilities,
  ProviderDriverKind,
  ServerProviderModel,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ServerProviderDraft } from "./snapshotProbe.ts";

export interface ProviderCatalogModel {
  readonly slug: string;
  readonly name: string;
  readonly shortName?: string;
  readonly subProvider?: string;
  readonly aliases?: ReadonlyArray<string>;
  readonly status: "current" | "legacy";
  readonly badge?: "new";
  readonly capabilities: ModelCapabilities | null;
  readonly adapter: unknown;
  readonly profileAdapter: unknown;
}

export interface ProviderCatalog {
  readonly models: ReadonlyArray<ProviderCatalogModel>;
  readonly defaultChatModel: string | undefined;
}

export class ModelCatalog extends Context.Service<
  ModelCatalog,
  {
    readonly current: (
      driverKind: ProviderDriverKind,
    ) => Effect.Effect<ProviderCatalog | undefined>;
    readonly bundled: (driverKind: ProviderDriverKind) => ProviderCatalog | undefined;
    readonly refreshInBackground: Effect.Effect<void>;
  }
>()("@t3tools/provider-core/server/ModelCatalog") {}

export const catalogServerModel = (
  catalog: ProviderCatalog,
  entry: ProviderCatalogModel,
): ServerProviderModel => ({
  slug: entry.slug,
  name: entry.name,
  ...(entry.shortName ? { shortName: entry.shortName } : {}),
  ...(entry.subProvider ? { subProvider: entry.subProvider } : {}),
  ...(entry.aliases ? { aliases: entry.aliases } : {}),
  ...(entry.badge ? { badge: entry.badge } : {}),
  isCustom: false,
  ...(catalog.defaultChatModel === entry.slug ? { isDefault: true } : {}),
  ...(entry.status === "legacy" ? { isLegacy: true } : {}),
  capabilities: entry.capabilities,
});

export interface CatalogMatching {
  readonly family?: (slug: string) => string;
}

const familyOf = (matching: CatalogMatching | undefined, slug: string) =>
  matching?.family?.(slug) ?? slug;

export function classifyCatalogModels(
  models: ReadonlyArray<ServerProviderModel>,
  catalog: ProviderCatalog | undefined,
  matching?: CatalogMatching,
): ReadonlyArray<ServerProviderModel> {
  return models.map((model) => {
    if (model.isCustom) return model;
    const entry =
      catalog?.models.find((candidate) => candidate.slug === model.slug) ??
      catalog?.models.find((candidate) => candidate.slug === familyOf(matching, model.slug));
    if (entry?.status === "legacy") return model.isLegacy ? model : { ...model, isLegacy: true };
    if (!model.isLegacy) return model;
    const { isLegacy: _isLegacy, ...rest } = model;
    return rest;
  });
}

export function applyCatalogDefault(
  models: ReadonlyArray<ServerProviderModel>,
  catalog: ProviderCatalog | undefined,
  matching?: CatalogMatching,
): ReadonlyArray<ServerProviderModel> {
  const requestedSlug = catalog?.defaultChatModel;
  if (requestedSlug === undefined) return models;
  const slug =
    models.find((model) => model.slug === requestedSlug)?.slug ??
    (matching?.family === undefined
      ? undefined
      : models.find(
          (model) =>
            !model.isCustom && familyOf(matching, model.slug) === familyOf(matching, requestedSlug),
        )?.slug);
  if (slug === undefined) return models;
  const previous = models.find((model) => model.isDefault && model.slug !== slug);
  if (!previous) return models;
  const movedAliases = previous.aliases ?? [];
  return models.map((model) => {
    if (model.slug === previous.slug) {
      const { isDefault: _isDefault, aliases: _aliases, ...rest } = model;
      return rest;
    }
    if (model.slug === slug) {
      const aliases = [...new Set([...(model.aliases ?? []), ...movedAliases])];
      return { ...model, isDefault: true, ...(aliases.length > 0 ? { aliases } : {}) };
    }
    return model;
  });
}

export function applyModelCatalog(
  draft: ServerProviderDraft,
  catalog: ProviderCatalog | undefined,
  matching?: CatalogMatching,
): ServerProviderDraft {
  const { updateRequiredModels: _previous, ...rest } = draft;
  return {
    ...rest,
    models: applyCatalogDefault(
      classifyCatalogModels(draft.models, catalog, matching),
      catalog,
      matching,
    ),
  };
}
