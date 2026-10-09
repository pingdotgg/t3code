/**
 * ModelCatalog — the model metadata a provider reads from T3's model manifest.
 *
 * The server owns the manifest itself (bundle, remote refresh, disk cache,
 * compatibility policies). A provider only sees its own catalog entry, so a
 * provider package never depends on the manifest file or how it is fetched.
 * Reads never wait on the network.
 *
 * @module provider-core/server/ModelCatalog
 */
import type {
  ModelCapabilities,
  ProviderDriverKind,
  ServerProviderModel,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ServerProviderDraft } from "./snapshotProbe.ts";

/** One model entry in a provider's manifest catalog. */
export interface ProviderCatalogModel {
  readonly slug: string;
  readonly name: string;
  readonly shortName?: string;
  readonly subProvider?: string;
  readonly aliases?: ReadonlyArray<string>;
  readonly status: "current" | "legacy";
  readonly badge?: "new";
  readonly capabilities: ModelCapabilities | null;
  /** Provider-owned metadata for this model; the provider decodes it. */
  readonly adapter: unknown;
  /** Provider-owned metadata for the model's capability profile. */
  readonly profileAdapter: unknown;
}

/** A provider's catalog entry: its models and the chat default. */
export interface ProviderCatalog {
  readonly models: ReadonlyArray<ProviderCatalogModel>;
  readonly defaultChatModel: string | undefined;
}

export class ModelCatalog extends Context.Service<
  ModelCatalog,
  {
    /**
     * The driver's catalog from the manifest in memory (disk cache or bundle),
     * or `undefined` when the manifest has no entry for it. Never fetches.
     */
    readonly current: (
      driverKind: ProviderDriverKind,
    ) => Effect.Effect<ProviderCatalog | undefined>;
    /** The same catalog from the bundled manifest; for fallbacks when remote data is invalid. */
    readonly bundled: (driverKind: ProviderDriverKind) => ProviderCatalog | undefined;
    /**
     * Starts a TTL-gated remote refresh in the background. Provider checks call
     * this; it never fails and never blocks the check.
     */
    readonly refreshInBackground: Effect.Effect<void>;
  }
>()("@t3tools/provider-core/server/ModelCatalog") {}

/** A catalog model as the snapshot model it presents. */
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

/** How a driver matches its discovered slugs to catalog entries. */
export interface CatalogMatching {
  /**
   * Maps a slug to the family the catalog names it by, such as a dated Codex
   * build to its base model. Defaults to the slug itself.
   */
  readonly family?: (slug: string) => string;
}

const familyOf = (matching: CatalogMatching | undefined, slug: string) =>
  matching?.family?.(slug) ?? slug;

/**
 * Reclassifies built-in models as legacy or current from the catalog. Custom
 * models are user-defined and never reclassified.
 */
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

/**
 * Moves `isDefault` to the catalog's chat default when the catalog names one
 * the models include. Providers that learn their default from the runtime can
 * be overridden here without a release. Aliases that pointed at the old
 * default move with the flag so the shared "provider default" alias keeps
 * resolving.
 */
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

/**
 * Reclassifies a snapshot draft's built-in models and moves its default from
 * the catalog. Drivers that announce models a newer CLI unlocks add
 * `updateRequiredModels` themselves; this clears a stale list.
 */
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
