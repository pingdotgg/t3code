import {
  ComposerDraftStoreState,
  ComposerThreadDraftState,
  LegacyCodexFields,
  PersistedComposerDraftStoreState,
  ProviderOptionSelectionsByProvider,
} from "./draftTypes";
import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  ModelSelection,
  ProviderInstanceId,
  ProviderDriverKind,
  ProviderOptionSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import { DeepMutable } from "effect/Types";
import {
  createModelSelection,
  normalizeCustomModelSlug,
  normalizeModelSlug,
} from "@t3tools/shared/model";
import {
  readInstanceCustomModels,
  resolveAppModelSelection,
  resolveAppModelSelectionForInstance,
} from "../modelSelection";
import { getDefaultServerModel } from "../providerModels";
import { UnifiedSettings } from "@t3tools/contracts/settings";
import * as Schema from "effect/Schema";

const isProviderDriverKind = Schema.is(ProviderDriverKind);
export interface EffectiveComposerModelState {
  selectedModel: string;
  modelOptions: ProviderOptionSelectionsByProvider | null;
}

export interface ComposerDraftModelState {
  activeProvider: ProviderInstanceId | null;
  modelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>>;
}

export function selectionsByInstance(
  modelSelection: ModelSelection | null | undefined,
): Partial<Record<string, ModelSelection>> | null {
  return modelSelection ? { [modelSelection.instanceId]: modelSelection } : null;
}

export function modelSelectionByProviderToOptions(
  map: Partial<Record<string, ModelSelection>> | null | undefined,
): ProviderOptionSelectionsByProvider | null {
  if (!map) return null;
  const result: ProviderOptionSelectionsByProvider = {};
  for (const [provider, selection] of Object.entries(map)) {
    if (selection?.options && selection.options.length > 0) {
      result[provider] = selection.options;
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

export function cloneModelSelection(selection: ModelSelection): DeepMutable<ModelSelection> {
  return {
    ...selection,
    ...(selection.options ? { options: selection.options.map((option) => ({ ...option })) } : {}),
  } as DeepMutable<ModelSelection>;
}

export function compactModelSelectionByProvider(
  selections: Partial<Record<ProviderInstanceId, ModelSelection>>,
): DeepMutable<Record<ProviderInstanceId, ModelSelection>> {
  const entries: Array<[string, DeepMutable<ModelSelection>]> = [];
  for (const [provider, selection] of Object.entries(selections)) {
    if (selection !== undefined) {
      entries.push([provider, cloneModelSelection(selection)]);
    }
  }
  return Object.fromEntries(entries) as DeepMutable<Record<ProviderInstanceId, ModelSelection>>;
}

export function compactStickyOptionsByModel(
  optionsByModelByProvider: ComposerDraftStoreState["stickyOptionsByModelByProvider"],
): NonNullable<PersistedComposerDraftStoreState["stickyOptionsByModelByProvider"]> {
  const result: Record<string, Record<string, ReadonlyArray<ProviderOptionSelection>>> = {};
  for (const [instanceId, optionsByModel] of Object.entries(optionsByModelByProvider)) {
    for (const [modelSlug, options] of Object.entries(optionsByModel ?? {})) {
      if (options === undefined || options.length === 0) continue;
      result[instanceId] ??= {};
      result[instanceId][modelSlug] = options;
    }
  }
  return result as NonNullable<PersistedComposerDraftStoreState["stickyOptionsByModelByProvider"]>;
}

export function seedStickyOptionsByModel(
  stickySelections: Partial<Record<ProviderInstanceId, ModelSelection>>,
): NonNullable<PersistedComposerDraftStoreState["stickyOptionsByModelByProvider"]> {
  const result: Record<string, Record<string, ReadonlyArray<ProviderOptionSelection>>> = {};
  for (const [instanceId, selection] of Object.entries(stickySelections)) {
    if (
      selection === undefined ||
      selection.options === undefined ||
      selection.options.length === 0
    ) {
      continue;
    }
    result[instanceId] = { [selection.model]: selection.options };
  }
  return result as NonNullable<PersistedComposerDraftStoreState["stickyOptionsByModelByProvider"]>;
}
export function normalizeProviderDriverKind(value: unknown): ProviderDriverKind | null {
  return isProviderDriverKind(value) ? value : null;
}

/** The schema owns validation; this permissive pattern keeps Effect Schema off the hot path. */
export const PROVIDER_INSTANCE_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

export function normalizeProviderInstanceId(value: unknown): ProviderInstanceId | null {
  if (typeof value !== "string") return null;
  if (!PROVIDER_INSTANCE_ID_PATTERN.test(value)) return null;
  return value as ProviderInstanceId;
}

export function coerceProviderOptionSelections(
  value: unknown,
): ReadonlyArray<ProviderOptionSelection> | undefined {
  if (Array.isArray(value)) {
    const out: ProviderOptionSelection[] = [];
    for (const entry of value) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const id = record.id;
      const optionValue = record.value;
      if (typeof id !== "string" || id.length === 0) continue;
      if (typeof optionValue === "string" || typeof optionValue === "boolean") {
        out.push({ id, value: optionValue });
      }
    }
    return out.length > 0 ? out : undefined;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: ProviderOptionSelection[] = [];
    for (const [id, raw] of Object.entries(record)) {
      if (typeof raw === "string" || typeof raw === "boolean") {
        out.push({ id, value: raw });
      }
    }
    return out.length > 0 ? out : undefined;
  }
  return undefined;
}

export function normalizeProviderModelOptions(
  value: unknown,
  provider?: ProviderDriverKind | null,
  legacy?: LegacyCodexFields,
): ProviderOptionSelectionsByProvider | null {
  const candidate = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const result: ProviderOptionSelectionsByProvider = {};
  for (const providerKey of ["codex", "claudeAgent", "cursor", "opencode"] as const) {
    const selections = coerceProviderOptionSelections(candidate?.[providerKey]);
    if (selections) {
      result[providerKey] = selections;
    }
  }

  if (provider === "codex" && legacy) {
    const codexExtras: ProviderOptionSelection[] = [];
    if (typeof legacy.effort === "string" && legacy.effort.length > 0) {
      codexExtras.push({ id: "reasoningEffort", value: legacy.effort });
    }
    const fastMode =
      legacy.codexFastMode === true ||
      (typeof legacy.serviceTier === "string" && legacy.serviceTier === "fast");
    if (fastMode) {
      codexExtras.push({ id: "fastMode", value: true });
    }
    if (codexExtras.length > 0) {
      const existing = result.codex ?? [];
      const existingIds = new Set(existing.map((entry) => entry.id));
      const merged = [...existing];
      for (const extra of codexExtras) {
        if (!existingIds.has(extra.id)) merged.push(extra);
      }
      result.codex = merged;
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

export function normalizeModelSelection(
  value: unknown,
  legacy?: {
    provider?: unknown;
    model?: unknown;
    modelOptions?: unknown;
    legacyCodex?: LegacyCodexFields;
  },
): NormalizedModelSelection | null {
  const candidate = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const instanceId = normalizeProviderInstanceId(
    candidate?.instanceId ?? candidate?.provider ?? legacy?.provider,
  );
  if (instanceId === null) {
    return null;
  }
  const rawModel = candidate?.model ?? legacy?.model;
  if (typeof rawModel !== "string") {
    return null;
  }
  const driverKindHint =
    normalizeProviderDriverKind(candidate?.provider ?? legacy?.provider) ??
    ProviderDriverKind.make("codex");
  // Instance-scoped picks are already resolved slugs; a custom slug can match a static alias.
  const model =
    candidate?.instanceId === undefined
      ? normalizeModelSlug(rawModel, driverKindHint)
      : normalizeCustomModelSlug(rawModel);
  if (!model) {
    return null;
  }
  if (Array.isArray(candidate?.options)) {
    const selections = coerceProviderOptionSelections(candidate.options);
    return createModelSelection(instanceId, model, selections) as NormalizedModelSelection;
  }
  const kindForLegacyOptions = normalizeProviderDriverKind(instanceId);
  const modelOptions = kindForLegacyOptions
    ? normalizeProviderModelOptions(
        candidate?.options ? { [kindForLegacyOptions]: candidate.options } : legacy?.modelOptions,
        kindForLegacyOptions,
        kindForLegacyOptions === "codex" ? legacy?.legacyCodex : undefined,
      )
    : null;
  const options = kindForLegacyOptions ? modelOptions?.[kindForLegacyOptions] : undefined;
  return createModelSelection(instanceId, model, options) as NormalizedModelSelection;
}

export type NormalizedModelSelection = Omit<ModelSelection, "instanceId"> & {
  readonly instanceId: ProviderInstanceId;
};

export function legacySyncModelSelectionOptions(
  modelSelection: NormalizedModelSelection | null,
  modelOptions: ProviderOptionSelectionsByProvider | null | undefined,
): NormalizedModelSelection | null {
  if (modelSelection === null) {
    return null;
  }
  const kind = normalizeProviderDriverKind(modelSelection.instanceId);
  const options = kind ? modelOptions?.[kind] : undefined;
  return createModelSelection(
    modelSelection.instanceId,
    modelSelection.model,
    options,
  ) as NormalizedModelSelection;
}

export function legacyMergeModelSelectionIntoProviderModelOptions(
  modelSelection: NormalizedModelSelection | null,
  currentModelOptions: ProviderOptionSelectionsByProvider | null | undefined,
): ProviderOptionSelectionsByProvider | null {
  if (!modelSelection?.options || modelSelection.options.length === 0) {
    return normalizeProviderModelOptions(currentModelOptions);
  }
  const kind = normalizeProviderDriverKind(modelSelection.instanceId);
  if (!kind) {
    return normalizeProviderModelOptions(currentModelOptions);
  }
  return legacyReplaceProviderModelOptions(
    normalizeProviderModelOptions(currentModelOptions),
    kind,
    modelSelection.options,
  );
}

export function legacyReplaceProviderModelOptions(
  currentModelOptions: ProviderOptionSelectionsByProvider | null | undefined,
  provider: ProviderDriverKind,
  nextProviderOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): ProviderOptionSelectionsByProvider | null {
  const { [provider]: _discardedProviderModelOptions, ...otherProviderModelOptions } =
    currentModelOptions ?? {};
  const merged: ProviderOptionSelectionsByProvider = { ...otherProviderModelOptions };
  if (nextProviderOptions && nextProviderOptions.length > 0) {
    merged[provider] = nextProviderOptions;
  }
  return Object.keys(merged).length > 0 ? merged : null;
}

export function legacyToModelSelectionByProvider(
  modelSelection: NormalizedModelSelection | null,
  modelOptions: ProviderOptionSelectionsByProvider | null | undefined,
): Partial<Record<ProviderInstanceId, ModelSelection>> {
  const result: Partial<Record<ProviderInstanceId, ModelSelection>> = {};
  if (modelOptions) {
    for (const provider of ["codex", "claudeAgent", "cursor", "opencode"] as const) {
      const options = modelOptions[provider];
      if (options && options.length > 0) {
        const driverKind = ProviderDriverKind.make(provider);
        const instanceKey = defaultInstanceIdForDriver(driverKind);
        result[instanceKey] = createModelSelection(
          instanceKey,
          modelSelection?.instanceId === instanceKey
            ? modelSelection.model
            : (DEFAULT_MODEL_BY_PROVIDER[driverKind] ?? DEFAULT_MODEL),
          options,
        );
      }
    }
  }
  if (modelSelection) {
    result[modelSelection.instanceId] = modelSelection as ModelSelection;
  }
  return result;
}

export function deriveEffectiveComposerModelState(input: {
  draft:
    | Pick<ComposerThreadDraftState, "modelSelectionByProvider" | "activeProvider">
    | null
    | undefined;
  providers: ReadonlyArray<ServerProvider>;
  selectedProvider: ProviderDriverKind;
  selectedInstanceId?: ProviderInstanceId | null | undefined;
  /** The instance the draft, thread or project asked for; differs from the selection on fallback. */
  requestedInstanceId?: ProviderInstanceId | null | undefined;
  threadModelSelection: ModelSelection | null | undefined;
  projectModelSelection: ModelSelection | null | undefined;
  settings: UnifiedSettings;
}): EffectiveComposerModelState {
  const baseModelCandidate =
    input.threadModelSelection?.model ?? input.projectModelSelection?.model ?? null;
  const preserveThreadModel =
    input.selectedInstanceId !== null &&
    input.selectedInstanceId !== undefined &&
    input.threadModelSelection?.instanceId === input.selectedInstanceId;
  const baseModel =
    (input.selectedInstanceId
      ? resolveAppModelSelectionForInstance(
          input.selectedInstanceId,
          input.settings,
          input.providers,
          baseModelCandidate,
          { preserveUnavailableSelection: preserveThreadModel },
        )
      : null) ??
    // Antigravity has no static model or cross-account catalog fallback.
    (input.selectedProvider === "antigravity" && input.selectedInstanceId ? "" : null) ??
    resolveAppModelSelection(
      input.selectedProvider,
      input.settings,
      input.providers,
      baseModelCandidate,
    ) ??
    normalizeModelSlug(baseModelCandidate, input.selectedProvider) ??
    getDefaultServerModel(input.providers, input.selectedProvider);
  const instanceSelection = input.selectedInstanceId
    ? input.draft?.modelSelectionByProvider?.[input.selectedInstanceId]
    : undefined;
  // Legacy driver-keyed drafts belong to the default instance.
  const legacySelection =
    input.selectedInstanceId &&
    input.selectedInstanceId !== defaultInstanceIdForDriver(input.selectedProvider)
      ? undefined
      : input.draft?.modelSelectionByProvider?.[ProviderInstanceId.make(input.selectedProvider)];
  const activeSelection = instanceSelection ?? legacySelection;
  const activeSelectionInstanceId = instanceSelection
    ? (input.selectedInstanceId ?? ProviderInstanceId.make(input.selectedProvider))
    : ProviderInstanceId.make(input.selectedProvider);
  const selectedModel = activeSelection?.model
    ? (resolveAppModelSelectionForInstance(
        activeSelectionInstanceId,
        input.settings,
        input.providers,
        activeSelection.model,
        { preserveUnavailableSelection: true },
      ) ??
      (input.selectedProvider === "antigravity" ? "" : null) ??
      resolveAppModelSelection(
        input.selectedProvider,
        input.settings,
        input.providers,
        activeSelection.model,
      ))
    : baseModel;
  // Options come from the first of the draft, thread and project that has any. Their selections
  // stay with them, so a fallback instance can check which model the options belong to.
  const optionSelections =
    [
      input.draft?.modelSelectionByProvider,
      selectionsByInstance(input.threadModelSelection),
      selectionsByInstance(input.projectModelSelection),
    ].find((selections) => modelSelectionByProviderToOptions(selections) !== null) ?? null;
  const modelOptions = modelSelectionByProviderToOptions(optionSelections);

  return {
    selectedModel,
    modelOptions: withFallbackInstanceOptions({
      ...input,
      modelOptions,
      optionSelections,
      selectedModel,
    }),
  };
}

/**
 * When the requested instance is disabled or unavailable, the composer shows another instance of
 * the same driver. When that instance has no options of its own and shows the model the requested
 * instance's options were picked with, it takes those options instead of the model's defaults.
 */
export function withFallbackInstanceOptions(input: {
  readonly modelOptions: ProviderOptionSelectionsByProvider | null;
  readonly optionSelections: Partial<Record<string, ModelSelection>> | null;
  readonly selectedModel: string;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly selectedProvider: ProviderDriverKind;
  readonly selectedInstanceId?: ProviderInstanceId | null | undefined;
  readonly requestedInstanceId?: ProviderInstanceId | null | undefined;
  readonly settings: UnifiedSettings;
}): ProviderOptionSelectionsByProvider | null {
  const { modelOptions, selectedInstanceId, requestedInstanceId } = input;
  if (
    !modelOptions ||
    !selectedInstanceId ||
    !requestedInstanceId ||
    selectedInstanceId === requestedInstanceId ||
    modelOptions[selectedInstanceId] !== undefined
  ) {
    return modelOptions;
  }
  const requestedOptions = modelOptions[requestedInstanceId];
  const requestedProvider = input.providers.find(
    (provider) => provider.instanceId === requestedInstanceId,
  );
  const requestedModel = input.optionSelections?.[requestedInstanceId]?.model;
  // Static aliases are shared across instances; exact custom slugs and catalog aliases are not.
  const modelIdentity = (instanceId: ProviderInstanceId, model: string | undefined) => {
    const isCustom =
      input.providers
        .find((provider) => provider.instanceId === instanceId)
        ?.models.some((entry) => entry.slug === model && entry.isCustom) ||
      readInstanceCustomModels(input.settings, instanceId, input.selectedProvider).some(
        (entry) => entry.slug === model,
      );
    return isCustom ? model : normalizeModelSlug(model, input.selectedProvider);
  };
  const sameModel =
    requestedModel === input.selectedModel ||
    modelIdentity(requestedInstanceId, requestedModel) ===
      modelIdentity(selectedInstanceId, input.selectedModel);
  if (!requestedOptions || requestedProvider?.driver !== input.selectedProvider || !sameModel) {
    return modelOptions;
  }
  return { ...modelOptions, [selectedInstanceId]: requestedOptions };
}
