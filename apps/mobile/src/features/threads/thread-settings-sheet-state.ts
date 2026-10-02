import type { ModelOption, ProviderGroup } from "../../lib/modelOptions";
import type { ProviderInstanceId } from "@t3tools/contracts";
import {
  getCodexDaybreakState,
  getModelSelectionStringOptionValue,
  withCodexDaybreakProgram,
} from "@t3tools/shared/model";

export type ModelFavorite = {
  readonly provider: ProviderInstanceId;
  readonly model: string;
};

export function modelFavoriteKey(provider: ProviderInstanceId, model: string): string {
  return `${provider}:${model}`;
}

export function toggleModelFavorite(
  favorites: ReadonlyArray<ModelFavorite>,
  option: ModelOption,
): ReadonlyArray<ModelFavorite> {
  const provider = option.selection.instanceId;
  const model = option.selection.model;
  return favorites.some((favorite) => favorite.provider === provider && favorite.model === model)
    ? favorites.filter((favorite) => favorite.provider !== provider || favorite.model !== model)
    : [...favorites, { provider, model }];
}

/** Keep catalog order within each group when favorites move to the front. */
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

/** Match the terms a user can actually see or recognize in the model picker. */
export function modelMatchesCatalogQuery(input: {
  readonly model: ModelOption;
  readonly providerLabel: string;
  readonly query: string;
}): boolean {
  const query = input.query.trim().toLocaleLowerCase();
  if (query.length === 0) {
    return true;
  }

  return [
    input.model.label,
    input.model.subtitle,
    input.model.selection.model,
    input.providerLabel,
  ].some((value) => value.toLocaleLowerCase().includes(query));
}

/** Preserve staged provider options when the highlighted model is tapped again. */
export function pendingModelAfterPress(input: {
  readonly current: ModelOption | null;
  readonly pressed: ModelOption;
  readonly pressedIsApplied: boolean;
  readonly daybreakEnabled?: boolean;
}): ModelOption | null {
  const pressed = input.current?.key === input.pressed.key ? input.current : input.pressed;
  const daybreak =
    input.daybreakEnabled === undefined ? null : getModelDaybreakToggleState(pressed);
  if (input.pressedIsApplied && !daybreak) {
    return null;
  }
  return daybreak
    ? {
        ...pressed,
        selection: withCodexDaybreakProgram(
          pressed.selection,
          input.daybreakEnabled ? daybreak.enabledValue : "standard",
        ),
      }
    : pressed;
}

export function getModelDaybreakToggleState(model: ModelOption) {
  return model.providerDriver === "codex" && !model.isUnavailable && model.capabilities
    ? getCodexDaybreakState(
        model.capabilities.optionDescriptors,
        getModelSelectionStringOptionValue(model.selection, "cyberAccessProgram"),
      )
    : null;
}

/** A model can disappear while the picker is open. */
export function canCommitPendingModel(
  pending: ModelOption,
  groups: ReadonlyArray<ProviderGroup>,
): boolean {
  return groups.some((group) =>
    group.models.some((model) => model.key === pending.key && !model.isUnavailable),
  );
}

/**
 * Primary and selected providers start open; all other catalogs start closed.
 * A user's disclosure tap inverts that default until the picker is dismissed.
 */
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
