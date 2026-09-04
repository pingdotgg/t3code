import {
  ANTIGRAVITY_DEFAULT_MODEL,
  DEFAULT_TEXT_GENERATION_MODEL,
  DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerSettingsPatch,
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

const MAX_CUSTOM_MODEL_COUNT = 32;
export const MAX_CUSTOM_MODEL_LENGTH = 256;
const DEFAULT_TEXT_GENERATION_INSTANCE_ID = ProviderInstanceId.make("codex");

/**
 * Resolve the custom-model list for a given instance, preferring the
 * instance's own `providerInstances[id].config.customModels` blob when
 * present and falling back to the legacy per-kind
 * `settings.providers[kind].customModels` bucket for default instances only.
 *
 * The Settings UI promotes the legacy bucket into an explicit
 * `providerInstances[defaultId]` entry on every edit (the "migrate on
 * first write" scheme documented in
 * `ProviderInstanceRegistryHydration`), so this helper exists primarily
 * so readers pick up that promotion immediately — and so first-time
 * viewers on pre-migration settings still see their legacy list on
 * default slots. Custom instances intentionally do not read the legacy
 * per-driver bucket; otherwise one custom model added to `claude_openrouter`
 * can appear on the stock `claudeAgent` instance.
 */
function readInstanceCustomModels(
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
  const defaultInstanceId = defaultInstanceIdForDriver(driverKind);
  if (instanceId !== defaultInstanceId) {
    return [];
  }
  const legacyProviders = settings.providers as Record<
    string,
    { readonly customModels: ReadonlyArray<unknown> } | undefined
  >;
  return readCustomModelEntries(legacyProviders[driverKind]?.customModels ?? []);
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

  // A model that exists in the raw catalog can be absent from `options`
  // because the user hid it. Keep that preference authoritative.
  if (resolveSelectableModel(provider, slug, rawModels) !== null) return options;
  if (hiddenModels.includes(slug)) return options;
  if (options.some((option) => option.slug === slug)) return options;

  return [...options, { slug, name: slug, isCustom: false, isUnavailable: true }];
}

function toAppModelOption(model: ServerProvider["models"][number]): AppModelOption {
  const option: AppModelOption = {
    slug: model.slug,
    name: model.name,
    isCustom: model.isCustom,
  };
  if (model.shortName) option.shortName = model.shortName;
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

export function normalizeCustomModelEntries(
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
    if (normalizedModels.length >= MAX_CUSTOM_MODEL_COUNT) {
      break;
    }
  }

  return normalizedModels;
}

export function getAppModelOptions(
  settings: UnifiedSettings,
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
  selectedModel?: string | null,
): AppModelOption[] {
  const rawModels = getProviderModels(providers, provider);
  // Server-reported custom rows mirror settings and can lag a removal, so
  // only built-ins are taken from the snapshot; custom rows are rebuilt from
  // settings below.
  const options: AppModelOption[] = rawModels
    .filter((model) => !model.isCustom)
    .map(toAppModelOption);
  const seen = new Set(options.map((option) => option.slug));
  const builtInModelSlugs = new Set(
    Arr.filterMap(getProviderModels(providers, provider), (model) =>
      model.isCustom ? Result.failVoid : Result.succeed(model.slug),
    ),
  );

  // Read from the default instance's config first (that's where edits
  // now land), falling back to the legacy per-kind bucket so unmigrated
  // settings and the initial render before the first write both still
  // see the user's authored custom models.
  const defaultInstanceId = defaultInstanceIdForDriver(provider);
  const customModels = readInstanceCustomModels(settings, defaultInstanceId, provider);
  for (const entry of normalizeCustomModelEntries(customModels, builtInModelSlugs)) {
    if (seen.has(entry.slug)) {
      continue;
    }

    seen.add(entry.slug);
    options.push({ slug: entry.slug, name: entry.name, isCustom: true });
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

/**
 * Instance-scoped variant of {@link getAppModelOptions}. Built-in models
 * come from the instance's own `entry.models` snapshot (rather than the
 * first-matching-kind fallback in `getProviderModels`), so each custom
 * instance gets the precise model list its driver reported. Custom model
 * slugs come from the instance's own `providerInstances[id].config.customModels`
 * when present, falling back to the legacy per-kind
 * `settings.providers[driverKind].customModels` bucket for default
 * instances only. This keeps two instances of the same kind from leaking
 * custom slugs into each other. Custom rows reported by the server are
 * ignored so a slug removed in Settings disappears without waiting for the
 * next provider probe.
 */
export function getAppModelOptionsForInstance(
  settings: UnifiedSettings,
  entry: ProviderInstanceEntry,
  selectedModel?: string | null,
): AppModelOption[] {
  const options: AppModelOption[] = entry.models
    .filter((model) => !model.isCustom)
    .map(toAppModelOption);
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
    options.push({ slug: custom.slug, name: custom.name, isCustom: true });
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

/**
 * Instance-keyed model options map. Each configured instance gets its own
 * option list so the model picker can show the same driver's built-in and
 * custom instances side by side without collapsing them.
 */
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

/**
 * Drop the opencode "plan" agent option from a stored model selection.
 * Used when legacy plan mode is turned off so server-side text-generation
 * tasks (title, branch, PR) cannot keep dispatching the plan agent.
 */
export function withoutPlanAgentSelection(
  selection: ModelSelection | null | undefined,
): ModelSelection | null | undefined {
  if (!selection?.options) {
    return selection;
  }
  const options = selection.options.filter(
    (option) => !(option.id === "agent" && option.value === "plan"),
  );
  if (options.length === selection.options.length) {
    return selection;
  }
  return createModelSelection(selection.instanceId, selection.model, options);
}

// The dropdown hides the opencode "plan" agent while legacy plan mode is off,
// but the persisted text-generation selections are only healed when the toggle
// flips. Users who already have plan mode off and a stored "plan" selection
// never trip the toggle handler, so resolve the heal once per settings load.
export function resolvePlanAgentHealPatch(input: {
  readonly planModeEnabled: boolean;
  readonly textGenerationModelSelection: ModelSelection | null | undefined;
  readonly sourceControlWriterModelSelection: ModelSelection | null | undefined;
}): ServerSettingsPatch | null {
  if (input.planModeEnabled) {
    return null;
  }
  const healedText = withoutPlanAgentSelection(input.textGenerationModelSelection);
  const healedSourceControl = withoutPlanAgentSelection(input.sourceControlWriterModelSelection);
  const patch: ServerSettingsPatch = {
    ...(healedText && healedText !== input.textGenerationModelSelection
      ? { textGenerationModelSelection: healedText }
      : {}),
    ...(healedSourceControl && healedSourceControl !== input.sourceControlWriterModelSelection
      ? { sourceControlWriterModelSelection: healedSourceControl }
      : {}),
  };
  return Object.keys(patch).length > 0 ? patch : null;
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
    // When the instance changed due to fallback (e.g. selected instance was disabled),
    // don't carry over the old instance's model — use the fallback instance's default.
    const selectedModel = selectedEntry ? selection.model : null;
    const model =
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
      planModeEnabled: settings.planModeEnabled,
    });

    return createModelSelection(entry.instanceId, model, modelOptionsForDispatch);
  }

  return NO_PROVIDER_MODEL_SELECTION;
}
