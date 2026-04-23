import {
  DEFAULT_MODEL_BY_PROVIDER,
  type ClaudeModelOptions,
  type CodexModelOptions,
  type CursorModelOptions,
  type ModelCapabilities,
  type OpenCodeModelOptions,
  type ProviderKind,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import {
  hasEffortLevel,
  normalizeModelSlug,
  resolveContextWindow,
  trimOrNull,
} from "@t3tools/shared/model";

const EMPTY_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

export function getProviderModels(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderKind,
): ReadonlyArray<ServerProviderModel> {
  return providers.find((candidate) => candidate.provider === provider)?.models ?? [];
}

export function getProviderSnapshot(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderKind,
): ServerProvider | undefined {
  return providers.find((candidate) => candidate.provider === provider);
}

export function isProviderEnabled(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderKind,
): boolean {
  if (provider === "acp") {
    return true;
  }
  if (providers.length === 0) {
    return true;
  }
  return getProviderSnapshot(providers, provider)?.enabled ?? false;
}

export function resolveSelectableProvider(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderKind | null | undefined,
): ProviderKind {
  const requested = provider ?? "codex";
  if (isProviderEnabled(providers, requested)) {
    return requested;
  }
  return providers.find((candidate) => candidate.enabled)?.provider ?? requested;
}

export function getProviderModelCapabilities(
  models: ReadonlyArray<ServerProviderModel>,
  model: string | null | undefined,
  provider: ProviderKind,
): ModelCapabilities {
  if (provider === "acp") {
    return EMPTY_CAPABILITIES;
  }
  const slug = normalizeModelSlug(model, provider);
  return models.find((candidate) => candidate.slug === slug)?.capabilities ?? EMPTY_CAPABILITIES;
}

export function getDefaultServerModel(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderKind,
): string {
  const models = getProviderModels(providers, provider);
  return (
    models.find((model) => !model.isCustom)?.slug ??
    models[0]?.slug ??
    DEFAULT_MODEL_BY_PROVIDER[provider]
  );
}

export function normalizeCodexModelOptionsWithCapabilities(
  caps: ModelCapabilities,
  modelOptions: CodexModelOptions | null | undefined,
): CodexModelOptions | undefined {
  const defaultReasoningEffort = caps.reasoningEffortLevels.find(
    (option) => option.isDefault,
  )?.value;
  const reasoningEffort =
    trimOrNull(modelOptions?.reasoningEffort) ?? defaultReasoningEffort ?? null;
  const fastModeEnabled = modelOptions?.fastMode === true;
  const nextOptions: CodexModelOptions = {
    ...(reasoningEffort && reasoningEffort !== defaultReasoningEffort
      ? { reasoningEffort: reasoningEffort as CodexModelOptions["reasoningEffort"] }
      : {}),
    ...(fastModeEnabled ? { fastMode: true } : {}),
  };
  return Object.keys(nextOptions).length > 0 ? nextOptions : undefined;
}

export function normalizeCursorModelOptionsWithCapabilities(
  caps: ModelCapabilities,
  modelOptions: CursorModelOptions | null | undefined,
): CursorModelOptions | undefined {
  const defaultEffort = caps.reasoningEffortLevels.find((option) => option.isDefault)?.value;
  const reasoning = trimOrNull(modelOptions?.reasoning);
  const reasoningValue =
    reasoning && hasEffortLevel(caps, reasoning) && reasoning !== defaultEffort
      ? (reasoning as CursorModelOptions["reasoning"])
      : undefined;
  const fastMode = caps.supportsFastMode && modelOptions?.fastMode === true ? true : undefined;
  const thinking =
    caps.supportsThinkingToggle && modelOptions?.thinking === false ? false : undefined;
  const contextWindow = resolveContextWindow(caps, modelOptions?.contextWindow);
  const nextOptions: CursorModelOptions = {
    ...(reasoningValue ? { reasoning: reasoningValue } : {}),
    ...(fastMode ? { fastMode: true } : {}),
    ...(thinking === false ? { thinking: false } : {}),
    ...(contextWindow ? { contextWindow } : {}),
  };
  return Object.keys(nextOptions).length > 0 ? nextOptions : undefined;
}

export function normalizeClaudeModelOptionsWithCapabilities(
  caps: ModelCapabilities,
  modelOptions: ClaudeModelOptions | null | undefined,
): ClaudeModelOptions | undefined {
  const defaultReasoningEffort = caps.reasoningEffortLevels.find(
    (option) => option.isDefault,
  )?.value;
  const resolvedEffort = trimOrNull(modelOptions?.effort);
  const isPromptInjected = caps.promptInjectedEffortLevels.includes(resolvedEffort ?? "");
  const effort =
    resolvedEffort &&
    !isPromptInjected &&
    hasEffortLevel(caps, resolvedEffort) &&
    resolvedEffort !== defaultReasoningEffort
      ? resolvedEffort
      : undefined;
  const thinking =
    caps.supportsThinkingToggle && typeof modelOptions?.thinking === "boolean"
      ? modelOptions.thinking
      : undefined;
  const fastMode =
    caps.supportsFastMode && typeof modelOptions?.fastMode === "boolean"
      ? modelOptions.fastMode
      : undefined;
  const contextWindow = resolveContextWindow(caps, modelOptions?.contextWindow);
  const nextOptions: ClaudeModelOptions = {
    ...(thinking !== undefined ? { thinking } : {}),
    ...(effort ? { effort } : {}),
    ...(fastMode !== undefined ? { fastMode } : {}),
    ...(contextWindow ? { contextWindow } : {}),
  };
  return Object.keys(nextOptions).length > 0 ? nextOptions : undefined;
}

function resolveLabeledOption(
  options: ReadonlyArray<{ value: string; isDefault?: boolean | undefined }> | undefined,
  raw: string | null | undefined,
): string | undefined {
  if (!options || options.length === 0) {
    return raw ?? undefined;
  }
  if (raw && options.some((option) => option.value === raw)) {
    return raw;
  }
  return options.find((option) => option.isDefault)?.value ?? options[0]?.value;
}

export function normalizeOpenCodeModelOptionsWithCapabilities(
  caps: ModelCapabilities,
  modelOptions: OpenCodeModelOptions | null | undefined,
): OpenCodeModelOptions | undefined {
  const variant = resolveLabeledOption(caps.variantOptions, trimOrNull(modelOptions?.variant));
  const agent = resolveLabeledOption(caps.agentOptions, trimOrNull(modelOptions?.agent));
  const nextOptions: OpenCodeModelOptions = {
    ...(variant ? { variant } : {}),
    ...(agent ? { agent } : {}),
  };
  return Object.keys(nextOptions).length > 0 ? nextOptions : undefined;
}
