import {
  DEFAULT_MODEL_BY_PROVIDER,
  MODEL_SLUG_ALIASES_BY_PROVIDER,
  type ClaudeCodeEffort,
  type ClaudeModelOptions,
  type CopilotModelOptions,
  type CodexModelOptions,
  type CodexReasoningEffort,
  type ModelCapabilities,
  type ModelSelection,
  type ModelSlug,
  type ProviderKind,
  type ProviderModelOptions,
} from "@t3tools/contracts";

export interface SelectableModelOption {
  slug: string;
  name: string;
}

export function getDefaultModel(provider: ProviderKind = "codex"): ModelSlug {
  return DEFAULT_MODEL_BY_PROVIDER[provider];
}

// ── Effort helpers ────────────────────────────────────────────────────

/** Check whether a capabilities object includes a given effort value. */
export function hasEffortLevel(caps: ModelCapabilities, value: string): boolean {
  return caps.reasoningEffortLevels.some((l) => l.value === value);
}

/** Return the default effort value for a capabilities object, or null if none. */
export function getDefaultEffort(caps: ModelCapabilities): string | null {
  return caps.reasoningEffortLevels.find((l) => l.isDefault)?.value ?? null;
}

export function isClaudeUltrathinkPrompt(text: string | null | undefined): boolean {
  return typeof text === "string" && /\bultrathink\b/i.test(text);
}

export function normalizeModelSlug(
  model: string | null | undefined,
  provider: ProviderKind = "codex",
): ModelSlug | null {
  if (typeof model !== "string") {
    return null;
  }

  const trimmed = model.trim();
  if (!trimmed) {
    return null;
  }

  const aliases = MODEL_SLUG_ALIASES_BY_PROVIDER[provider] as Record<string, ModelSlug>;
  const aliased = Object.prototype.hasOwnProperty.call(aliases, trimmed)
    ? aliases[trimmed]
    : undefined;
  return typeof aliased === "string" ? aliased : (trimmed as ModelSlug);
}

export function resolveSelectableModel(
  provider: ProviderKind,
  value: string | null | undefined,
  options: ReadonlyArray<SelectableModelOption>,
): ModelSlug | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const direct = options.find((option) => option.slug === trimmed);
  if (direct) {
    return direct.slug;
  }

  const byName = options.find((option) => option.name.toLowerCase() === trimmed.toLowerCase());
  if (byName) {
    return byName.slug;
  }

  const normalized = normalizeModelSlug(trimmed, provider);
  if (!normalized) {
    return null;
  }

  const resolved = options.find((option) => option.slug === normalized);
  return resolved ? resolved.slug : null;
}

export function resolveModelSlug(
  model: string | null | undefined,
  provider: ProviderKind = "codex",
): ModelSlug {
  const normalized = normalizeModelSlug(model, provider);
  if (!normalized) {
    return DEFAULT_MODEL_BY_PROVIDER[provider];
  }
  return normalized;
}

export function resolveModelSlugForProvider(
  provider: ProviderKind,
  model: string | null | undefined,
): ModelSlug {
  return resolveModelSlug(model, provider);
}

/** Trim a string, returning null for empty/missing values. */
export function trimOrNull<T extends string>(value: T | null | undefined): T | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim() as T;
  return trimmed || null;
}

export function normalizeCodexModelOptions(
  caps: ModelCapabilities,
  modelOptions: CodexModelOptions | null | undefined,
): CodexModelOptions | undefined {
  const defaultReasoningEffort = getDefaultEffort(caps);
  const reasoningEffort = trimOrNull(modelOptions?.reasoningEffort) ?? defaultReasoningEffort;
  const fastModeEnabled = modelOptions?.fastMode === true;
  const nextOptions: CodexModelOptions = {
    ...(reasoningEffort && reasoningEffort !== defaultReasoningEffort
      ? { reasoningEffort: reasoningEffort as CodexModelOptions["reasoningEffort"] }
      : {}),
    ...(fastModeEnabled ? { fastMode: true } : {}),
  };
  return Object.keys(nextOptions).length > 0 ? nextOptions : undefined;
}

export function normalizeClaudeModelOptions(
  caps: ModelCapabilities,
  modelOptions: ClaudeModelOptions | null | undefined,
): ClaudeModelOptions | undefined {
  const defaultReasoningEffort = getDefaultEffort(caps);
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
    caps.supportsThinkingToggle && modelOptions?.thinking === false ? false : undefined;
  const fastMode = caps.supportsFastMode && modelOptions?.fastMode === true ? true : undefined;
  const nextOptions: ClaudeModelOptions = {
    ...(thinking === false ? { thinking: false } : {}),
    ...(effort ? { effort } : {}),
    ...(fastMode ? { fastMode: true } : {}),
  };
  return Object.keys(nextOptions).length > 0 ? nextOptions : undefined;
}

export function normalizeCopilotModelOptions(
  caps: ModelCapabilities,
  modelOptions: CopilotModelOptions | null | undefined,
): CopilotModelOptions | undefined {
  const defaultReasoningEffort = getDefaultEffort(caps) as CodexReasoningEffort | null;
  const resolvedReasoningEffort = trimOrNull(modelOptions?.reasoningEffort);
  const reasoningEffort =
    resolvedReasoningEffort &&
    hasEffortLevel(caps, resolvedReasoningEffort) &&
    resolvedReasoningEffort !== defaultReasoningEffort
      ? resolvedReasoningEffort
      : undefined;
  return reasoningEffort ? { reasoningEffort } : undefined;
}

export function normalizeModelOptionsForProvider<P extends ProviderKind>(
  provider: P,
  caps: ModelCapabilities,
  modelOptions: ProviderModelOptions[P] | null | undefined,
): ProviderModelOptions[P] | undefined {
  switch (provider) {
    case "codex":
      return normalizeCodexModelOptions(caps, modelOptions as CodexModelOptions | undefined) as
        | ProviderModelOptions[P]
        | undefined;
    case "claudeAgent":
      return normalizeClaudeModelOptions(caps, modelOptions as ClaudeModelOptions | undefined) as
        | ProviderModelOptions[P]
        | undefined;
    case "copilot":
      return normalizeCopilotModelOptions(caps, modelOptions as CopilotModelOptions | undefined) as
        | ProviderModelOptions[P]
        | undefined;
  }
}

export function buildModelSelection<P extends ProviderKind>(
  provider: P,
  model: ModelSlug,
  options?: ProviderModelOptions[P],
): Extract<ModelSelection, { provider: P }> {
  switch (provider) {
    case "codex": {
      const codexOptions = options as ProviderModelOptions["codex"] | undefined;
      return (
        codexOptions
          ? { provider: "codex", model, options: codexOptions }
          : { provider: "codex", model }
      ) as Extract<ModelSelection, { provider: P }>;
    }
    case "claudeAgent": {
      const claudeOptions = options as ProviderModelOptions["claudeAgent"] | undefined;
      return (
        claudeOptions
          ? { provider: "claudeAgent", model, options: claudeOptions }
          : { provider: "claudeAgent", model }
      ) as Extract<ModelSelection, { provider: P }>;
    }
    case "copilot": {
      const copilotOptions = options as ProviderModelOptions["copilot"] | undefined;
      return (
        copilotOptions
          ? { provider: "copilot", model, options: copilotOptions }
          : { provider: "copilot", model }
      ) as Extract<ModelSelection, { provider: P }>;
    }
  }
}

export function applyClaudePromptEffortPrefix(
  text: string,
  effort: ClaudeCodeEffort | null | undefined,
): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (effort !== "ultrathink") {
    return trimmed;
  }
  if (trimmed.startsWith("Ultrathink:")) {
    return trimmed;
  }
  return `Ultrathink:\n${trimmed}`;
}
