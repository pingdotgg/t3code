import type { ModelFavorite, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { AUTO_LEVEL_MODELS, isAutoModelSlug } from "@t3tools/shared/autoModel";

import type { ModelEsque } from "./providerIconUtils";

type Favorite = typeof ModelFavorite.Type;

/** Keeps a hidden model visible while its provider is locked or turned off. */
export function retainedModelWhileProviderLocked(
  entry: {
    readonly driverKind: ProviderDriverKind;
    readonly enabled: boolean;
    readonly isAvailable: boolean;
    readonly models: ReadonlyArray<Pick<ModelEsque, "slug" | "name" | "shortName" | "subProvider">>;
  } | null,
  model: string,
): ModelEsque | undefined {
  if (!entry || (entry.enabled && entry.isAvailable) || !model) return undefined;
  if (entry.driverKind === "opencode" || entry.driverKind === "antigravity") return undefined;
  return entry.models.find((candidate) => candidate.slug === model) ?? { slug: model, name: model };
}

/**
 * Auto High, Medium and Low lead Favorites on every machine, from the first Claude instance that
 * lists them, until the user stars an Auto level themselves.
 */
export function withPinnedAutoLevels(
  favorites: ReadonlyArray<Favorite>,
  entries: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly driverKind: ProviderDriverKind;
  }>,
  optionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<{ readonly slug: string }>>,
): ReadonlyArray<Favorite> {
  if (favorites.some((favorite) => isAutoModelSlug(favorite.model))) return favorites;
  const levels = AUTO_LEVEL_MODELS.map((model) => model.slug).reverse();
  const host = entries.find(
    (entry) =>
      entry.driverKind === "claudeAgent" &&
      levels.every((slug) =>
        (optionsByInstance.get(entry.instanceId) ?? []).some((option) => option.slug === slug),
      ),
  );
  if (!host) return favorites;
  return [...levels.map((model) => ({ provider: host.instanceId, model })), ...favorites];
}

/** Favorites view order: Auto High, Medium, Low first, then the rest as sorted. */
export function autoLevelsFirst<T extends { readonly slug: string }>(items: ReadonlyArray<T>): T[] {
  const levels = AUTO_LEVEL_MODELS.map((model) => model.slug).reverse();
  const auto = levels.flatMap((slug) => items.filter((item) => item.slug === slug));
  return [...auto, ...items.filter((item) => !levels.includes(item.slug))];
}
