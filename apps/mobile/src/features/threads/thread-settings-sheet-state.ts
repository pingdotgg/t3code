import type { ModelOption, ProviderGroup } from "../../lib/modelOptions";
import { SEARCH_FAVORITE_SCORE_BOOST, scoreSearchFields } from "@t3tools/shared/searchRanking";
import type { ModelSelection, ProviderInstanceId } from "@t3tools/contracts";

export function modelFavoriteKey(provider: ProviderInstanceId, model: string): string {
  return `${provider}:${model}`;
}

export function favoritesFirst(
  models: ReadonlyArray<ModelOption>,
  favoriteKeys: ReadonlySet<string>,
): ReadonlyArray<ModelOption> {
  const favorites: ModelOption[] = [];
  const others: ModelOption[] = [];
  for (const model of models) {
    (favoriteKeys.has(model.key) ? favorites : others).push(model);
  }
  return [...favorites, ...others];
}

/** Rank the terms a user can actually see or recognize in the model picker. */
export function scoreModelCatalogQuery(input: {
  readonly model: ModelOption;
  readonly providerLabel: string;
  readonly query: string;
}): number | null {
  return scoreSearchFields(
    [
      input.model.label,
      input.model.selection.model,
      { value: input.model.subtitle, weight: 20 },
      { value: input.providerLabel, weight: 30 },
    ],
    input.query,
  );
}

export function visibleCatalogModels(input: {
  readonly models: ReadonlyArray<ModelOption>;
  readonly providerLabel: string;
  readonly query: string;
  readonly favoriteKeys: ReadonlySet<string>;
  readonly favoritesOnly: boolean;
  readonly showLegacy: boolean;
  readonly isDisplayed: (model: ModelOption) => boolean;
}): ReadonlyArray<ModelOption> {
  const catalogModels =
    input.showLegacy || input.favoritesOnly || input.query.trim().length > 0
      ? input.models
      : input.models.filter(
          (model) =>
            !model.isLegacy || input.isDisplayed(model) || input.favoriteKeys.has(model.key),
        );
  const favoriteOrderedModels = favoritesFirst(
    catalogModels.filter((model) => !input.favoritesOnly || input.favoriteKeys.has(model.key)),
    input.favoriteKeys,
  );
  return favoriteOrderedModels
    .flatMap((model, index) => {
      const score = scoreModelCatalogQuery({
        model,
        providerLabel: input.providerLabel,
        query: input.query,
      });
      if (score === null) return [];
      const boost =
        input.query.trim() && input.favoriteKeys.has(model.key) ? SEARCH_FAVORITE_SCORE_BOOST : 0;
      return [{ model, index, score: score - boost }];
    })
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map(({ model }) => model);
}

export function pendingModelAfterPress(input: {
  readonly current: ModelOption | null;
  readonly pressed: ModelOption;
  readonly pressedIsApplied: boolean;
  readonly restoreSelection?: (selection: ModelSelection) => ModelSelection;
}): ModelOption | null {
  if (input.pressedIsApplied) {
    return null;
  }
  if (input.current?.key === input.pressed.key) {
    return input.current;
  }
  return input.restoreSelection
    ? { ...input.pressed, selection: input.restoreSelection(input.pressed.selection) }
    : input.pressed;
}

export function canCommitPendingModel(
  pending: ModelOption,
  groups: ReadonlyArray<ProviderGroup>,
): boolean {
  return groups.some((group) =>
    group.models.some(
      (model) => model.key === pending.key && !model.isUnavailable && !model.isHidden,
    ),
  );
}

export function providerSectionIsCollapsed(input: {
  readonly defaultExpanded: boolean;
  readonly hasExpansionOverride: boolean;
  readonly isNarrowed: boolean;
}): boolean {
  if (input.isNarrowed) {
    return false;
  }
  return input.defaultExpanded ? input.hasExpansionOverride : !input.hasExpansionOverride;
}
