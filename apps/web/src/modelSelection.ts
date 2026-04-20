import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  type ModelSelection,
  type ProviderKind,
  type ServerProvider,
} from "@workbench/contracts";
import {
  createModelSelection,
  normalizeModelSlug,
  resolveSelectableModel,
} from "@workbench/shared/model";
import { getComposerProviderState } from "./components/chat/composerProviderRegistry";
import { UnifiedSettings } from "@workbench/contracts/settings";
import {
  getDefaultServerModel,
  getProviderModels,
  resolveSelectableProvider,
} from "./providerModels";

const MAX_CUSTOM_MODEL_COUNT = 32;
export const MAX_CUSTOM_MODEL_LENGTH = 256;

export type ProviderCustomModelConfig = {
  provider: ProviderKind;
  title: string;
  description: string;
  placeholder: string;
  example: string;
};

export interface AppModelOption {
  slug: string;
  name: string;
  isCustom: boolean;
}

export interface PickerModelOption {
  slug: string;
  name: string;
}

const PROVIDER_CUSTOM_MODEL_CONFIG: Record<ProviderKind, ProviderCustomModelConfig> = {
  codex: {
    provider: "codex",
    title: "Codex",
    description: "Save additional Codex model slugs for the picker and `/model` command.",
    placeholder: "your-codex-model-slug",
    example: "gpt-6.7-codex-ultra-preview",
  },
  claudeAgent: {
    provider: "claudeAgent",
    title: "Claude",
    description: "Save additional Claude model slugs for the picker and `/model` command.",
    placeholder: "your-claude-model-slug",
    example: "claude-sonnet-5-0",
  },
  cursor: {
    provider: "cursor",
    title: "Cursor",
    description: "Save additional Cursor model slugs for the picker and `/model` command.",
    placeholder: "your-cursor-model-slug",
    example: "claude-sonnet-4-6",
  },
  opencode: {
    provider: "opencode",
    title: "OpenCode",
    description: "Save additional OpenCode model slugs in `provider/model` format.",
    placeholder: "openai/gpt-5",
    example: "anthropic/claude-sonnet-4-5-20250929",
  },
  pi: {
    provider: "pi",
    title: "pi",
    description: "Save additional pi model slugs in `provider/model` format.",
    placeholder: "anthropic/claude-sonnet-4-6",
    example: "openai/gpt-5",
  },
};

export const MODEL_PROVIDER_SETTINGS = Object.values(PROVIDER_CUSTOM_MODEL_CONFIG);

export function normalizeCustomModelSlugs(
  models: Iterable<string | null | undefined>,
  builtInModelSlugs: ReadonlySet<string>,
  provider: ProviderKind = "codex",
): string[] {
  const normalizedModels: string[] = [];
  const seen = new Set<string>();

  for (const candidate of models) {
    const normalized = normalizeModelSlug(candidate, provider);
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
  provider: ProviderKind,
  selectedModel?: string | null,
): AppModelOption[] {
  const options: AppModelOption[] = getProviderModels(providers, provider).map(
    ({ slug, name, isCustom }) => ({
      slug,
      name,
      isCustom,
    }),
  );
  const seen = new Set(options.map((option) => option.slug));
  const trimmedSelectedModel = selectedModel?.trim().toLowerCase();
  const builtInModelSlugs = new Set(
    getProviderModels(providers, provider)
      .filter((model) => !model.isCustom)
      .map((model) => model.slug),
  );

  const customModels = settings.providers[provider].customModels;
  for (const slug of normalizeCustomModelSlugs(customModels, builtInModelSlugs, provider)) {
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

  const normalizedSelectedModel = normalizeModelSlug(selectedModel, provider);
  const selectedModelMatchesExistingName =
    typeof trimmedSelectedModel === "string" &&
    options.some((option) => option.name.toLowerCase() === trimmedSelectedModel);
  if (
    normalizedSelectedModel &&
    !seen.has(normalizedSelectedModel) &&
    !selectedModelMatchesExistingName
  ) {
    options.push({
      slug: normalizedSelectedModel,
      name: normalizedSelectedModel,
      isCustom: true,
    });
  }

  return options;
}

function normalizeConfiguredModelSlugs(
  models: Iterable<string | null | undefined>,
  provider: ProviderKind,
): string[] {
  const normalizedModels: string[] = [];
  const seen = new Set<string>();

  for (const candidate of models) {
    const normalized = normalizeModelSlug(candidate, provider);
    if (!normalized || normalized.length > MAX_CUSTOM_MODEL_LENGTH || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    normalizedModels.push(normalized);
  }

  return normalizedModels;
}

export function getConfiguredFavoriteModelOptions(
  settings: UnifiedSettings,
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderKind,
): PickerModelOption[] {
  if (provider !== "pi") {
    return [];
  }

  const options = getAppModelOptions(settings, providers, provider);
  if (options.length === 0) {
    return [];
  }

  const optionsBySlug = new Map(options.map((option) => [option.slug, option] as const));
  return normalizeConfiguredModelSlugs(settings.providers.pi.favoriteModels, provider)
    .map((slug) => optionsBySlug.get(slug))
    .filter((option): option is AppModelOption => option !== undefined)
    .map(({ slug, name }) => ({ slug, name }));
}

export function getPreferredPickerModelOptions(
  settings: UnifiedSettings,
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderKind,
  selectedModel?: string | null,
): PickerModelOption[] {
  const options = getAppModelOptions(settings, providers, provider, selectedModel).map(
    ({ slug, name }) => ({ slug, name }),
  );
  if (provider !== "pi") {
    return options;
  }

  const favorites = getConfiguredFavoriteModelOptions(settings, providers, provider);
  if (favorites.length === 0) {
    return options;
  }

  const selectedSlug = resolveSelectableModel(provider, selectedModel, options);
  if (!selectedSlug || favorites.some((option) => option.slug === selectedSlug)) {
    return favorites;
  }

  const selectedOption = options.find((option) => option.slug === selectedSlug);
  return selectedOption ? [...favorites, selectedOption] : favorites;
}

export function resolveProviderDefaultModel(
  provider: ProviderKind,
  settings: UnifiedSettings,
  providers: ReadonlyArray<ServerProvider>,
): string {
  const resolvedProvider = resolveSelectableProvider(providers, provider);
  const options = getAppModelOptions(settings, providers, resolvedProvider).map(
    ({ slug, name }) => ({ slug, name }),
  );
  const preferredOptions = getPreferredPickerModelOptions(settings, providers, resolvedProvider);
  const fallbackOptions =
    resolvedProvider === "pi" && preferredOptions.length > 0 ? preferredOptions : options;
  const configuredDefault =
    resolvedProvider === "pi"
      ? resolveSelectableModel(
          resolvedProvider,
          settings.providers.pi.defaultModel,
          fallbackOptions,
        )
      : null;

  return (
    configuredDefault ??
    fallbackOptions[0]?.slug ??
    getDefaultServerModel(providers, resolvedProvider)
  );
}

export function resolveAppModelSelection(
  provider: ProviderKind,
  settings: UnifiedSettings,
  providers: ReadonlyArray<ServerProvider>,
  selectedModel: string | null | undefined,
): string {
  const resolvedProvider = resolveSelectableProvider(providers, provider);
  const options = getAppModelOptions(settings, providers, resolvedProvider, selectedModel);
  return (
    resolveSelectableModel(resolvedProvider, selectedModel, options) ??
    resolveProviderDefaultModel(resolvedProvider, settings, providers)
  );
}

export function getCustomModelOptionsByProvider(
  settings: UnifiedSettings,
  providers: ReadonlyArray<ServerProvider>,
  selectedProvider?: ProviderKind | null,
  selectedModel?: string | null,
): Record<ProviderKind, ReadonlyArray<{ slug: string; name: string }>> {
  return {
    codex: getPreferredPickerModelOptions(
      settings,
      providers,
      "codex",
      selectedProvider === "codex" ? selectedModel : undefined,
    ),
    claudeAgent: getPreferredPickerModelOptions(
      settings,
      providers,
      "claudeAgent",
      selectedProvider === "claudeAgent" ? selectedModel : undefined,
    ),
    cursor: getPreferredPickerModelOptions(
      settings,
      providers,
      "cursor",
      selectedProvider === "cursor" ? selectedModel : undefined,
    ),
    opencode: getPreferredPickerModelOptions(
      settings,
      providers,
      "opencode",
      selectedProvider === "opencode" ? selectedModel : undefined,
    ),
    pi: getPreferredPickerModelOptions(
      settings,
      providers,
      "pi",
      selectedProvider === "pi" ? selectedModel : undefined,
    ),
  };
}

export function resolveAppModelSelectionState(
  settings: UnifiedSettings,
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection {
  const selection = settings.textGenerationModelSelection ?? {
    provider: "codex" as const,
    model: DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER.codex,
  };
  const provider = resolveSelectableProvider(providers, selection.provider);

  // When the provider changed due to fallback (e.g. selected provider was disabled),
  // don't carry over the old provider's model — use the fallback provider's default.
  const selectedModel = provider === selection.provider ? selection.model : null;
  const model = resolveAppModelSelection(provider, settings, providers, selectedModel);
  const { modelOptionsForDispatch } = getComposerProviderState({
    provider,
    model,
    models: getProviderModels(providers, provider),
    prompt: "",
    modelOptions: {
      [provider]: provider === selection.provider ? selection.options : undefined,
    },
  });

  return createModelSelection(provider, model, modelOptionsForDispatch);
}
