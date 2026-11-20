import { isReasoningSelect } from "@t3tools/client-runtime/model-traits";
import type { ModelOption, ProviderGroup } from "../../lib/modelOptions";
import type {
  ModelSelection,
  ProviderInstanceId,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
  RuntimeMode,
} from "@t3tools/contracts";

export function resolvePendingRuntimeMode(
  pendingMode: RuntimeMode | null,
  choices: ReadonlyArray<{ readonly mode: RuntimeMode; readonly disabledReason?: string }>,
): RuntimeMode | null | undefined {
  if (pendingMode === null) return null;
  return choices.find(
    (choice) => choice.mode === pendingMode && choice.disabledReason === undefined,
  )?.mode;
}

export function overlayPendingOptionDescriptors(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  pendingOptions: ReadonlyArray<ProviderOptionSelection> | null,
): ReadonlyArray<ProviderOptionDescriptor> {
  if (pendingOptions === null) return descriptors;
  return descriptors.map((descriptor): ProviderOptionDescriptor => {
    const entry = pendingOptions.find((option) => option.id === descriptor.id);
    if (!entry) return descriptor;
    if (descriptor.type === "select") {
      return {
        ...descriptor,
        currentValue: typeof entry.value === "string" ? entry.value : descriptor.currentValue,
      };
    }
    return {
      ...descriptor,
      currentValue: typeof entry.value === "boolean" ? entry.value : descriptor.currentValue,
    };
  });
}

export function partitionThreadSettingsDescriptors(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
) {
  const reasoning = descriptors.find(isReasoningSelect) ?? null;
  const speed =
    descriptors.find((entry) => entry.id === "serviceTier" && entry.type === "select") ??
    descriptors.find((entry) => entry.id === "fastMode" && entry.type === "boolean") ??
    null;
  const ultracode =
    descriptors.find((entry) => entry.id === "ultracode" && entry.type === "boolean") ?? null;
  const extraOptions = descriptors.filter(
    (entry) => entry.id !== reasoning?.id && entry.id !== speed?.id && entry.id !== ultracode?.id,
  );
  return { reasoning, speed, ultracode, extraOptions };
}

export function resolveDefaultProviderFilter(input: {
  readonly providerGroups: ReadonlyArray<ProviderGroup>;
  readonly favoriteKeys: ReadonlySet<string>;
  readonly lockedProviderInstanceId?: ProviderInstanceId;
  readonly favoritesFilter: string;
}): string | null {
  if (input.lockedProviderInstanceId) {
    return null;
  }
  const hasVisibleFavorite = input.providerGroups.some((group) =>
    group.models.some((model) => !model.isHidden && input.favoriteKeys.has(model.key)),
  );
  return hasVisibleFavorite ? input.favoritesFilter : null;
}

export function resolveEffectiveProviderFilter(input: {
  readonly userFilter: string | null | undefined;
  readonly defaultFilter: string | null;
  readonly searchQuery: string;
  readonly manageHidden: boolean;
  readonly favoritesFilter: string;
}): string | null {
  const activeFilter = input.userFilter === undefined ? input.defaultFilter : input.userFilter;
  if (
    activeFilter === input.favoritesFilter &&
    (input.searchQuery.trim().length > 0 || input.manageHidden)
  ) {
    return null;
  }
  return activeFilter;
}

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
