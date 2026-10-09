import type { ModelOption, ProviderGroup } from "../../lib/modelOptions";
import type { ProviderInstanceId } from "@t3tools/contracts";
import { getCodexDaybreakState, withCodexDaybreakProgram } from "@t3tools/shared/model";

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

/** Preserve staged options using current capabilities, dropping revoked Daybreak access. */
export function pendingModelAfterPress(input: {
  readonly current: ModelOption | null;
  readonly pressed: ModelOption;
  readonly pressedIsApplied: boolean;
  readonly daybreakProgram?: string;
}): ModelOption | null {
  const daybreak = getModelDaybreakToggleState(input.pressed);
  const program = daybreak ? input.daybreakProgram : undefined;
  const previous =
    input.current?.key === input.pressed.key ? input.current.selection : input.pressed.selection;
  const selection = {
    ...previous,
    options: previous.options?.filter(
      (option) =>
        option.id !== "cyberAccessProgram" ||
        option.value === "standard" ||
        daybreak?.programs.some((program) => program === option.value),
    ),
  };
  if (
    input.daybreakProgram &&
    input.daybreakProgram !== "standard" &&
    !daybreak?.programs.some((program) => program === input.daybreakProgram)
  )
    return input.current?.key === input.pressed.key
      ? { ...input.pressed, selection }
      : input.current;
  if (input.pressedIsApplied && program === undefined) return null;
  return { ...input.pressed, selection: withCodexDaybreakProgram(selection, program) };
}

export function getModelDaybreakToggleState(model: ModelOption) {
  return model.providerDriver === "codex" && !model.isUnavailable && model.capabilities
    ? getCodexDaybreakState(model.capabilities.optionDescriptors)
    : null;
}

/** Refresh staged options against the catalog before saving; missing models cannot commit. */
export function resolvePendingModelForCommit(
  pending: ModelOption,
  groups: ReadonlyArray<ProviderGroup>,
) {
  const model = groups
    .flatMap((group) => group.models)
    .find((model) => model.key === pending.key && !model.isUnavailable);
  return model
    ? pendingModelAfterPress({ current: pending, pressed: model, pressedIsApplied: false })
    : null;
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
