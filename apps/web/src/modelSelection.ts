import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  type ModelSelection,
  type ProviderKind,
  type ProviderOptionSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import { UnifiedSettings } from "@t3tools/contracts/settings";
import {
  createModelSelection,
  normalizeModelSlug,
  resolveSelectableModel,
} from "@t3tools/shared/model";

import { getComposerProviderState } from "./components/chat/composerProviderState";
import { type ModelEsque } from "./components/chat/providerIconUtils";
import { formatAppModelOptionName } from "./providerModelNames";
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
  shortName?: string;
  subProvider?: string;
  isCustom: boolean;
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
  gemini: {
    provider: "gemini",
    title: "Gemini",
    description: "Save additional Gemini model ids for the picker and `/model` command.",
    placeholder: "your-gemini-model-id",
    example: "gemini-model-id-from-cli",
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
};

export const MODEL_PROVIDER_SETTINGS = Object.values(PROVIDER_CUSTOM_MODEL_CONFIG);

export function buildModelSelection(input: {
  provider: ProviderKind;
  model: string;
  options?: ReadonlyArray<ProviderOptionSelection> | null;
}): ModelSelection {
  return createModelSelection(input.provider, input.model, input.options);
}

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
  const options: AppModelOption[] = getProviderModels(providers, provider).map((model) => {
    const option: AppModelOption = {
      slug: model.slug,
      name: model.name,
      isCustom: model.isCustom,
    };
    if (model.shortName) {
      option.shortName = model.shortName;
    }
    if (model.subProvider) {
      option.subProvider = model.subProvider;
    }
    return option;
  });
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
      name: formatAppModelOptionName(provider, slug),
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
      name: formatAppModelOptionName(provider, normalizedSelectedModel),
      isCustom: true,
    });
  }

  return options;
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
    getDefaultServerModel(providers, resolvedProvider)
  );
}

export function getCustomModelOptionsByProvider(
  settings: UnifiedSettings,
  providers: ReadonlyArray<ServerProvider>,
  selectedProvider?: ProviderKind | null,
  selectedModel?: string | null,
): Record<ProviderKind, ReadonlyArray<ModelEsque>> {
  return {
    codex: getAppModelOptions(
      settings,
      providers,
      "codex",
      selectedProvider === "codex" ? selectedModel : undefined,
    ),
    claudeAgent: getAppModelOptions(
      settings,
      providers,
      "claudeAgent",
      selectedProvider === "claudeAgent" ? selectedModel : undefined,
    ),
    gemini: getAppModelOptions(
      settings,
      providers,
      "gemini",
      selectedProvider === "gemini" ? selectedModel : undefined,
    ),
    cursor: getAppModelOptions(
      settings,
      providers,
      "cursor",
      selectedProvider === "cursor" ? selectedModel : undefined,
    ),
    opencode: getAppModelOptions(
      settings,
      providers,
      "opencode",
      selectedProvider === "opencode" ? selectedModel : undefined,
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

  const selectedModel = provider === selection.provider ? selection.model : null;
  const model = resolveAppModelSelection(provider, settings, providers, selectedModel);
  const { modelOptionsForDispatch } = getComposerProviderState({
    provider,
    model,
    models: getProviderModels(providers, provider),
    prompt: "",
    modelOptions: provider === selection.provider ? selection.options : undefined,
  });

  return createModelSelection(provider, model, modelOptionsForDispatch);
}
