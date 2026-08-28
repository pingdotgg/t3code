import {
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
  createModelSelection,
  normalizeCustomModelSlug,
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
import { type ProviderInstanceEntry, deriveProviderInstanceEntries } from "./providerInstances";
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
): ReadonlyArray<string> {
  const instance = settings.providerInstances?.[instanceId];
  const config = instance?.config;
  if (config !== null && typeof config === "object") {
    const value = (config as Record<string, unknown>).customModels;
    if (Array.isArray(value)) {
      return value.filter((entry): entry is string => typeof entry === "string");
    }
  }
  const defaultInstanceId = defaultInstanceIdForDriver(driverKind);
  if (instanceId !== defaultInstanceId) {
    return [];
  }
  const legacyProviders = settings.providers as Record<
    string,
    { readonly customModels: ReadonlyArray<string> } | undefined
  >;
  return legacyProviders[driverKind]?.customModels ?? [];
}

export interface AppModelOption {
  slug: string;
  name: string;
  shortName?: string;
  subProvider?: string;
  isCustom: boolean;
  isDefault?: boolean;
  isLegacy?: boolean;
  isUnavailable?: boolean;
}

function appendUnavailableOpenCodeSelection(
  options: AppModelOption[],
  rawModels: ReadonlyArray<ServerProvider["models"][number]>,
  provider: ProviderDriverKind,
  selectedModel: string | null | undefined,
  hiddenModels: ReadonlyArray<string>,
): AppModelOption[] {
  if (provider !== "opencode") return options;
  const slug = normalizeCustomModelSlug(selectedModel);
  if (!slug) return options;

  // A model that exists in the raw catalog can be absent from `options`
  // because the user hid it. Keep that preference authoritative.
  if (rawModels.some((model) => model.slug === slug)) return options;
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

export function normalizeCustomModelSlugs(
  models: Iterable<string | null | undefined>,
  builtInModelSlugs: ReadonlySet<string>,
): string[] {
  const normalizedModels: string[] = [];
  const seen = new Set<string>();

  for (const candidate of models) {
    const normalized = normalizeCustomModelSlug(candidate);
    if (
      !normalized ||
      normalized.length > MAX_CUSTOM_MODEL_LENGTH ||
      builtInModelSlugs.has(normalized) ||
      seen.has(normalized)
    ) {
      continue;
    }

    seen.add(normalized);
    normalizedModels.push(normalized);
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
  const options: AppModelOption[] = rawModels.map(toAppModelOption);
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
  for (const slug of normalizeCustomModelSlugs(customModels, builtInModelSlugs)) {
    if (seen.has(slug)) {
      continue;
    }

    seen.add(slug);
    options.push({
      slug,
      name: slug,
      isCustom: true,
    });
  }

  const preferences = readInstanceModelPreferences(settings, defaultInstanceId);
  return appendUnavailableOpenCodeSelection(
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
 * custom slugs into each other.
 */
export function getAppModelOptionsForInstance(
  settings: UnifiedSettings,
  entry: ProviderInstanceEntry,
  selectedModel?: string | null,
): AppModelOption[] {
  const options: AppModelOption[] = entry.models.map(toAppModelOption);
  const seen = new Set(options.map((option) => option.slug));
  const builtInModelSlugs = new Set(
    Arr.filterMap(entry.models, (model) =>
      model.isCustom ? Result.failVoid : Result.succeed(model.slug),
    ),
  );

  const customModels = readInstanceCustomModels(settings, entry.instanceId, entry.driverKind);
  for (const slug of normalizeCustomModelSlugs(customModels, builtInModelSlugs)) {
    if (seen.has(slug)) {
      continue;
    }

    seen.add(slug);
    options.push({ slug, name: slug, isCustom: true });
  }

  const preferences = readInstanceModelPreferences(settings, entry.instanceId);
  return appendUnavailableOpenCodeSelection(
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
  if (resolutionOptions?.preserveUnavailableSelection && entry.driverKind === "opencode") {
    const unavailableSelection = normalizeCustomModelSlug(selectedModel);
    const hiddenModels = readInstanceModelPreferences(settings, entry.instanceId).hiddenModels;
    if (unavailableSelection && !hiddenModels.includes(unavailableSelection)) {
      return unavailableSelection;
    }
  }
  return (
    options.find((option) => option.isDefault)?.slug ??
    options[0]?.slug ??
    entry.models.find((model) => model.isDefault)?.slug ??
    entry.models[0]?.slug ??
    null
  );
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
  const entries = deriveProviderInstanceEntries(providers);
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
      resolveAppModelSelectionForInstance(entry.instanceId, settings, providers, selectedModel) ??
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

  const provider = resolveSelectableProvider(providers, null);
  const keptSelectedProvider = false;

  // When the provider changed due to fallback (e.g. selected provider was disabled),
  // don't carry over the old provider's model — use the fallback provider's default.
  const selectedModel = keptSelectedProvider ? selection.model : null;
  const model = resolveAppModelSelection(provider, settings, providers, selectedModel);
  const { modelOptionsForDispatch } = getComposerProviderState({
    provider,
    model,
    models: getProviderModels(providers, provider),
    modelOptions: keptSelectedProvider ? selection.options : undefined,
    planModeEnabled: settings.planModeEnabled,
  });

  return createModelSelection(defaultInstanceIdForDriver(provider), model, modelOptionsForDispatch);
}
