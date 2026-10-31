import type { ModelOption, ProviderGroup } from "../../lib/modelOptions";
import type { EnvironmentId, ModelSelection, ProviderInstanceId } from "@t3tools/contracts";

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
  confirmedGroups = groups,
): boolean {
  return (
    selectableModelKeys(groups).has(pending.key) &&
    (confirmedGroups === groups || selectableModelKeys(confirmedGroups).has(pending.key))
  );
}

export function selectableModelKeys(groups: ReadonlyArray<ProviderGroup>) {
  return new Set(
    groups.flatMap((group) =>
      group.models
        .filter((model) => !model.isUnavailable && !model.isHidden)
        .map((model) => model.key),
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

export type HiddenModelOverride = {
  readonly hidden: boolean;
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
  overrides: ReadonlyMap<string, HiddenModelOverride>,
  includeHidden = true,
) {
  const pendingHiddenKeys = new Set<string>();
  if (!environmentId || overrides.size === 0)
    return { providerGroups: groups, overrides, pendingHiddenKeys };
  let reconciled: Map<string, HiddenModelOverride> | undefined;
  const providerGroups = groups
    .map((group) => ({
      ...group,
      models: group.models.flatMap((model) => {
        const key = hiddenModelOverrideKey(environmentId, model.selection);
        const override = model.canHide ? overrides.get(key) : undefined;
        if (override && override.hidden === (model.isHidden === true)) {
          (reconciled ??= new Map(overrides)).delete(key);
        } else if (override) {
          pendingHiddenKeys.add(model.key);
        }
        const effective =
          override && override.hidden !== (model.isHidden === true)
            ? { ...model, isHidden: override.hidden }
            : model;
        return includeHidden || !effective.isHidden ? [effective] : [];
      }),
    }))
    .filter((group) => group.models.length > 0);
  return { providerGroups, overrides: reconciled ?? overrides, pendingHiddenKeys };
}

export function settleHiddenModelOverride(
  overrides: ReadonlyMap<string, HiddenModelOverride>,
  key: string,
  override: HiddenModelOverride,
  succeeded: boolean,
): ReadonlyMap<string, HiddenModelOverride> {
  if (succeeded || overrides.get(key) !== override) return overrides;
  const next = new Map(overrides);
  next.delete(key);
  return next;
}
