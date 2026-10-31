import type { ModelOption, ProviderGroup } from "../../lib/modelOptions";
import type {
  EnvironmentId,
  ModelSelection,
  ProviderInstanceId,
  ServerSettings,
} from "@t3tools/contracts";

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

/** A local visibility toggle shown until the write settles and a newer settings snapshot replaces `baseline`. */
export type HiddenModelOverride = {
  readonly hidden: boolean;
  readonly baseline: ServerSettings;
  readonly pending: boolean;
};

export function hiddenModelOverrideKey(
  environmentId: EnvironmentId,
  selection: Pick<ModelSelection, "instanceId" | "model">,
): string {
  return JSON.stringify([environmentId, selection.instanceId, selection.model]);
}

export function withHiddenModelOverrides(
  groups: ReadonlyArray<ProviderGroup>,
  environmentId: EnvironmentId | null,
  settings: ServerSettings | undefined,
  overrides: ReadonlyMap<string, HiddenModelOverride>,
): ReadonlyArray<ProviderGroup> {
  if (!environmentId || overrides.size === 0) return groups;
  return groups.map((group) => ({
    ...group,
    models: group.models.map((model) => {
      const override = overrides.get(hiddenModelOverrideKey(environmentId, model.selection));
      if (
        !override ||
        !model.canHide ||
        (!override.pending && override.baseline !== settings) ||
        override.hidden === (model.isHidden === true)
      ) {
        return model;
      }
      return { ...model, isHidden: override.hidden };
    }),
  }));
}

export function settleHiddenModelOverride(
  overrides: ReadonlyMap<string, HiddenModelOverride>,
  key: string,
  override: HiddenModelOverride,
  succeeded: boolean,
  currentSettings: ServerSettings | undefined,
): ReadonlyMap<string, HiddenModelOverride> {
  if (overrides.get(key) !== override) return overrides;
  const next = new Map(overrides);
  if (succeeded && currentSettings === override.baseline) {
    next.set(key, { ...override, pending: false });
  } else {
    next.delete(key);
  }
  return next;
}
