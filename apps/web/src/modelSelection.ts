import {
  ANTIGRAVITY_DEFAULT_MODEL,
  DEFAULT_TEXT_GENERATION_MODEL,
  DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  type CustomModelDefinition,
  createModelSelection,
  normalizeCustomModelSlug,
  readCustomModelEntries,
  resolveSelectableModel,
} from "@t3tools/shared/model";
import { getComposerProviderState } from "./components/chat/composerProviderState";
import { UnifiedSettings } from "@t3tools/contracts/settings";
import * as Arr from "effect/Array";
import * as Result from "effect/Result";
import {
  getDefaultServerModel,
  getProviderModels,
  resolveSelectableProvider,
} from "./providerModels";
import { ModelEsque } from "./components/chat/providerIconUtils";
import {
  type ProviderInstanceEntry,
  deriveProviderInstanceEntries,
  NO_PROVIDER_MODEL_SELECTION,
} from "./providerInstances";
import { sortModelsForProviderInstance } from "./modelOrdering";
import { resolveModelShortName } from "@t3tools/client-runtime/provider-clients";

export const MAX_CUSTOM_MODEL_LENGTH = 256;
const DEFAULT_TEXT_GENERATION_INSTANCE_ID = ProviderInstanceId.make("codex");

// Legacy per-driver buckets would leak custom-instance models into stock instances.
export function readInstanceCustomModels(
  settings: UnifiedSettings,
  instanceId: ProviderInstanceId,
  driverKind: ProviderDriverKind,
): ReadonlyArray<CustomModelDefinition> {
  if (driverKind === "antigravity") return [];
  const instance = settings.providerInstances?.[instanceId];
  const config = instance?.config;
  if (config !== null && typeof config === "object") {
    const value = (config as Record<string, unknown>).customModels;
    if (Array.isArray(value)) {
      return readCustomModelEntries(value);
    }
  }
  return [];
}

export interface AppModelOption {
  slug: string;
  name: string;
  shortName?: string;
  subProvider?: string;
  aliases?: ReadonlyArray<string>;
  badge?: "new";
  isCustom: boolean;
  isDefault?: boolean;
  isLegacy?: boolean;
  isUnavailable?: boolean;
}

function appendUnavailableDynamicModelSelection(
  options: AppModelOption[],
  rawModels: ReadonlyArray<ServerProvider["models"][number]>,
  provider: ProviderDriverKind,
  selectedModel: string | null | undefined,
  hiddenModels: ReadonlyArray<string>,
): AppModelOption[] {
  if (provider !== "opencode" && provider !== "antigravity") return options;
  const slug = normalizeCustomModelSlug(selectedModel);
  if (!slug) return options;
  if (provider === "antigravity" && slug === ANTIGRAVITY_DEFAULT_MODEL) return options;

  if (resolveSelectableModel(provider, slug, rawModels) !== null) return options;
  if (hiddenModels.includes(slug)) return options;
  if (options.some((option) => option.slug === slug)) return options;

  return [...options, { slug, name: slug, isCustom: false, isUnavailable: true }];
}

function toAppModelOption(
  model: ServerProvider["models"][number],
  driverKind: ProviderDriverKind,
): AppModelOption {
  const option: AppModelOption = {
    slug: model.slug,
    name: model.name,
    isCustom: model.isCustom,
  };
  const shortName = resolveModelShortName(model, driverKind);
  if (shortName) option.shortName = shortName;
  if (model.subProvider) option.subProvider = model.subProvider;
  if (model.aliases) option.aliases = model.aliases;
  if (model.badge) option.badge = model.badge;
  if (model.isDefault) option.isDefault = true;
  if (model.isLegacy) option.isLegacy = true;
  return option;
}

function readInstanceModelPreferences(
  settings: UnifiedSettings,
  instanceId: ProviderInstanceId,
): { readonly hiddenModels: ReadonlyArray<string>; readonly modelOrder: ReadonlyArray<string> } {
  return (
    settings.providerModelPreferences?.[instanceId] ?? {
      hiddenModels: [],
      modelOrder: [],
    }
  );
}

function applyInstanceModelPreferences(
  options: ReadonlyArray<AppModelOption>,
  preferences: {
    readonly hiddenModels: ReadonlyArray<string>;
    readonly modelOrder: ReadonlyArray<string>;
  },
): AppModelOption[] {
  const hiddenModels = new Set(preferences.hiddenModels);
  return sortModelsForProviderInstance(
    options.filter((option) => option.isCustom || !hiddenModels.has(option.slug)),
    { modelOrder: preferences.modelOrder },
  );
}

function normalizeCustomModelEntries(
  models: ReadonlyArray<CustomModelDefinition>,
  builtInModelSlugs: ReadonlySet<string>,
): CustomModelDefinition[] {
  const normalizedModels: CustomModelDefinition[] = [];
  const seen = new Set<string>();

  for (const candidate of models) {
    if (
      candidate.slug.length > MAX_CUSTOM_MODEL_LENGTH ||
      builtInModelSlugs.has(candidate.slug) ||
      seen.has(candidate.slug)
    ) {
      continue;
    }

    seen.add(candidate.slug);
    normalizedModels.push(candidate);
  }

  return normalizedModels;
}

function getAppModelOptions(
  settings: UnifiedSettings,
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
  selectedModel?: string | null,
): AppModelOption[] {
  const rawModels = getProviderModels(providers, provider);
  // Server custom-model snapshots can lag removals; rebuild custom rows from settings.
  const options: AppModelOption[] = rawModels
    .filter((model) => !model.isCustom)
    .map((model) => toAppModelOption(model, provider));
  const seen = new Set(options.map((option) => option.slug));
  const builtInModelSlugs = new Set(
    Arr.filterMap(getProviderModels(providers, provider), (model) =>
      model.isCustom ? Result.failVoid : Result.succeed(model.slug),
    ),
  );

  const defaultInstanceId = defaultInstanceIdForDriver(provider);
  const customModels = readInstanceCustomModels(settings, defaultInstanceId, provider);
  for (const entry of normalizeCustomModelEntries(customModels, builtInModelSlugs)) {
    if (seen.has(entry.slug)) {
      continue;
    }

    seen.add(entry.slug);
    const shortName = resolveModelShortName(entry, provider);
    options.push({
      slug: entry.slug,
      name: entry.name,
      isCustom: true,
      ...(shortName ? { shortName } : {}),
    });
  }

  const preferences = readInstanceModelPreferences(settings, defaultInstanceId);
  return appendUnavailableDynamicModelSelection(
    applyInstanceModelPreferences(options, preferences),
    rawModels,
    provider,
    selectedModel,
    preferences.hiddenModels,
  );
}

export function getAppModelOptionsForInstance(
  settings: UnifiedSettings,
  entry: ProviderInstanceEntry,
  selectedModel?: string | null,
): AppModelOption[] {
  const options: AppModelOption[] = entry.models
    .filter((model) => !model.isCustom)
    .map((model) => toAppModelOption(model, entry.driverKind));
  const seen = new Set(options.map((option) => option.slug));
  const builtInModelSlugs = new Set(
    Arr.filterMap(entry.models, (model) =>
      model.isCustom ? Result.failVoid : Result.succeed(model.slug),
    ),
  );

  const customModels = readInstanceCustomModels(settings, entry.instanceId, entry.driverKind);
  for (const custom of normalizeCustomModelEntries(customModels, builtInModelSlugs)) {
    if (seen.has(custom.slug)) {
      continue;
    }

    seen.add(custom.slug);
    const shortName = resolveModelShortName(custom, entry.driverKind);
    options.push({
      slug: custom.slug,
      name: custom.name,
      isCustom: true,
      ...(shortName ? { shortName } : {}),
    });
  }

  const preferences = readInstanceModelPreferences(settings, entry.instanceId);
  return appendUnavailableDynamicModelSelection(
    applyInstanceModelPreferences(options, preferences),
    entry.models,
    entry.driverKind,
    selectedModel,
    preferences.hiddenModels,
  );
}

export function resolveAppModelSelection(
  provider: ProviderDriverKind,
  settings: UnifiedSettings,
  providers: ReadonlyArray<ServerProvider>,
  selectedModel: string | null | undefined,
): string {
  const resolvedProvider = resolveSelectableProvider(providers, provider);
  const options = getAppModelOptions(settings, providers, resolvedProvider, selectedModel);
  return (
    resolveSelectableModel(resolvedProvider, selectedModel, options) ??
    getDefaultServerModel(providers, resolvedProvider)
  );
}

export function resolveAppModelSelectionForInstance(
  instanceId: ProviderInstanceId,
  settings: UnifiedSettings,
  providers: ReadonlyArray<ServerProvider>,
  selectedModel: string | null | undefined,
  resolutionOptions?: { readonly preserveUnavailableSelection?: boolean },
): string | null {
  const entry = deriveProviderInstanceEntries(providers).find(
    (candidate) => candidate.instanceId === instanceId,
  );
  if (!entry) return null;
  const options = getAppModelOptionsForInstance(
    settings,
    entry,
    resolutionOptions?.preserveUnavailableSelection ? selectedModel : null,
  );
  const resolvedSelection = resolveSelectableModel(entry.driverKind, selectedModel, options);
  if (resolvedSelection) {
    return resolvedSelection;
  }
  if (
    resolutionOptions?.preserveUnavailableSelection &&
    (entry.driverKind === "opencode" || entry.driverKind === "antigravity")
  ) {
    const unavailableSelection = normalizeCustomModelSlug(selectedModel);
    const hiddenModels = readInstanceModelPreferences(settings, entry.instanceId).hiddenModels;
    if (
      unavailableSelection &&
      !hiddenModels.includes(unavailableSelection) &&
      resolveSelectableModel(entry.driverKind, selectedModel, entry.models) === null &&
      (entry.driverKind !== "antigravity" || unavailableSelection !== ANTIGRAVITY_DEFAULT_MODEL)
    ) {
      return unavailableSelection;
    }
  }
  return options.find((option) => option.isDefault)?.slug ?? options[0]?.slug ?? null;
}

// New drafts carry the stored selection; capabilities resolve its raw options later.
export function resolveEffectiveDefaultModelSelection(
  settings: UnifiedSettings,
  providers: ReadonlyArray<ServerProvider>,
  selection: ModelSelection,
): ModelSelection {
  const model = resolveAppModelSelectionForInstance(
    selection.instanceId,
    settings,
    providers,
    selection.model,
    { preserveUnavailableSelection: true },
  );
  return model === null || model === selection.model ? selection : { ...selection, model };
}

export function getCustomModelOptionsByInstance(
  settings: UnifiedSettings,
  providers: ReadonlyArray<ServerProvider>,
  selectedInstanceId?: ProviderInstanceId | null,
  selectedModel?: string | null,
): ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>> {
  const out = new Map<ProviderInstanceId, ReadonlyArray<ModelEsque>>();
  for (const entry of deriveProviderInstanceEntries(providers)) {
    out.set(
      entry.instanceId,
      getAppModelOptionsForInstance(
        settings,
        entry,
        entry.instanceId === selectedInstanceId ? selectedModel : null,
      ),
    );
  }
  return out;
}

export function selectsPlanAgent(options: ModelSelection["options"]): boolean {
  return options?.some((option) => option.id === "agent" && option.value === "plan") ?? false;
}

export function resolveAppModelSelectionState(
  settings: UnifiedSettings,
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection {
  const selection = settings.textGenerationModelSelection ?? {
    instanceId: DEFAULT_TEXT_GENERATION_INSTANCE_ID,
    model: DEFAULT_TEXT_GENERATION_MODEL,
  };
  const supportedProviders = providers.filter(
    (provider) => provider.supportsTextGeneration !== false,
  );
  const entries = deriveProviderInstanceEntries(supportedProviders);
  const selectedEntry = entries.find(
    (entry) => entry.instanceId === selection.instanceId && entry.enabled && entry.isAvailable,
  );
  const entry =
    selectedEntry ?? entries.find((candidate) => candidate.enabled && candidate.isAvailable);
  if (entry) {
    const selectedModel = selectedEntry ? selection.model : null;
    // Use the cheap generation default; the catalog default is the expensive chat flagship.
    const options = getAppModelOptionsForInstance(settings, entry);
    const model =
      resolveSelectableModel(entry.driverKind, selectedModel, options) ??
      resolveSelectableModel(
        entry.driverKind,
        DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[entry.driverKind],
        options,
      ) ??
      resolveAppModelSelectionForInstance(
        entry.instanceId,
        settings,
        supportedProviders,
        selectedModel,
      ) ??
      entry.models[0]?.slug ??
      DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[entry.driverKind];
    if (!model) {
      return createModelSelection(entry.instanceId, "", []);
    }
    const provider = entry.driverKind;
    const { modelOptionsForDispatch } = getComposerProviderState({
      provider,
      model,
      models: entry.models,
      modelOptions: selectedEntry ? selection.options : undefined,
      planModeEnabled: settings.planModeEnabled || selectsPlanAgent(selection.options),
    });

    return createModelSelection(entry.instanceId, model, modelOptionsForDispatch);
  }

  return NO_PROVIDER_MODEL_SELECTION;
}
