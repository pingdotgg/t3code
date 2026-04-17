import {
  DEFAULT_MODEL_BY_PROVIDER,
  MODEL_SLUG_ALIASES_BY_PROVIDER,
  type ClaudeAgentEffort,
  type ClaudeModelOptions,
  type CodexModelOptions,
  type CursorModelOptions,
  type ModelCapabilities,
  type ModelSelection,
  type OpenCodeModelOptions,
  type ProviderKind,
  type ProviderModelOptions,
} from "@t3tools/contracts";

export interface SelectableModelOption {
  slug: string;
  name: string;
}

/** Check whether a capabilities object includes a given effort value. */
export function hasEffortLevel(caps: ModelCapabilities, value: string): boolean {
  return caps.reasoningEffortLevels.some((l) => l.value === value);
}

/** Return the default effort value for a capabilities object, or null if none. */
export function getDefaultEffort(caps: ModelCapabilities): string | null {
  return caps.reasoningEffortLevels.find((l) => l.isDefault)?.value ?? null;
}

/**
 * Resolve a raw effort option against capabilities.
 *
 * Returns the explicit supported value when present and not prompt-injected,
 * otherwise the model default. Returns `undefined` when the model exposes no
 * effort levels.
 */
export function resolveEffort(
  caps: ModelCapabilities,
  raw: string | null | undefined,
): string | undefined {
  const defaultValue = getDefaultEffort(caps);
  const trimmed = typeof raw === "string" ? raw.trim() : null;
  if (
    trimmed &&
    !caps.promptInjectedEffortLevels.includes(trimmed) &&
    hasEffortLevel(caps, trimmed)
  ) {
    return trimmed;
  }
  return defaultValue ?? undefined;
}

/** Check whether a capabilities object includes a given context window value. */
export function hasContextWindowOption(caps: ModelCapabilities, value: string): boolean {
  return caps.contextWindowOptions.some((o) => o.value === value);
}

/** Return the default context window value, or `null` if none is defined. */
export function getDefaultContextWindow(caps: ModelCapabilities): string | null {
  return caps.contextWindowOptions.find((o) => o.isDefault)?.value ?? null;
}

/**
 * Resolve a raw `contextWindow` option against capabilities.
 *
 * Returns the explicit supported value when present, otherwise the model
 * default. Returns `undefined` when the model exposes no context window options.
 */
export function resolveContextWindow(
  caps: ModelCapabilities,
  raw: string | null | undefined,
): string | undefined {
  const defaultValue = getDefaultContextWindow(caps);
  if (!raw) return defaultValue ?? undefined;
  return hasContextWindowOption(caps, raw) ? raw : (defaultValue ?? undefined);
}

export function normalizeCodexModelOptionsWithCapabilities(
  caps: ModelCapabilities,
  modelOptions: CodexModelOptions | null | undefined,
): CodexModelOptions | undefined {
  const reasoningEffort = resolveEffort(caps, modelOptions?.reasoningEffort);
  const fastMode = caps.supportsFastMode ? modelOptions?.fastMode : undefined;
  const nextOptions: CodexModelOptions = {
    ...(reasoningEffort
      ? { reasoningEffort: reasoningEffort as CodexModelOptions["reasoningEffort"] }
      : {}),
    ...(fastMode !== undefined ? { fastMode } : {}),
  };
  return Object.keys(nextOptions).length > 0 ? nextOptions : undefined;
}

export function normalizeClaudeModelOptionsWithCapabilities(
  caps: ModelCapabilities,
  modelOptions: ClaudeModelOptions | null | undefined,
): ClaudeModelOptions | undefined {
  const effort = resolveEffort(caps, modelOptions?.effort);
  const thinking = caps.supportsThinkingToggle ? modelOptions?.thinking : undefined;
  const fastMode = caps.supportsFastMode ? modelOptions?.fastMode : undefined;
  const contextWindow = resolveContextWindow(caps, modelOptions?.contextWindow);
  const nextOptions: ClaudeModelOptions = {
    ...(thinking !== undefined ? { thinking } : {}),
    ...(effort ? { effort: effort as ClaudeModelOptions["effort"] } : {}),
    ...(fastMode !== undefined ? { fastMode } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  };
  return Object.keys(nextOptions).length > 0 ? nextOptions : undefined;
}

export function normalizeCursorModelOptionsWithCapabilities(
  caps: ModelCapabilities,
  modelOptions: CursorModelOptions | null | undefined,
): CursorModelOptions | undefined {
  const reasoning = resolveEffort(caps, modelOptions?.reasoning);
  const thinking = caps.supportsThinkingToggle ? modelOptions?.thinking : undefined;
  const fastMode = caps.supportsFastMode ? modelOptions?.fastMode : undefined;
  const contextWindow = resolveContextWindow(caps, modelOptions?.contextWindow);
  const nextOptions: CursorModelOptions = {
    ...(reasoning ? { reasoning: reasoning as CursorModelOptions["reasoning"] } : {}),
    ...(fastMode !== undefined ? { fastMode } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
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
  return options.find((option) => option.isDefault)?.value;
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

export function normalizeProviderModelOptionsWithCapabilities(
  provider: ProviderKind,
  caps: ModelCapabilities,
  modelOptions: ProviderModelOptions[ProviderKind] | null | undefined,
): ProviderModelOptions[ProviderKind] | undefined {
  switch (provider) {
    case "codex":
      return normalizeCodexModelOptionsWithCapabilities(caps, modelOptions as CodexModelOptions);
    case "claudeAgent":
      return normalizeClaudeModelOptionsWithCapabilities(caps, modelOptions as ClaudeModelOptions);
    case "cursor":
      return normalizeCursorModelOptionsWithCapabilities(caps, modelOptions as CursorModelOptions);
    case "opencode":
      return normalizeOpenCodeModelOptionsWithCapabilities(
        caps,
        modelOptions as OpenCodeModelOptions,
      );
  }
}

export function isClaudeUltrathinkPrompt(text: string | null | undefined): boolean {
  return typeof text === "string" && /\bultrathink\b/i.test(text);
}

export function normalizeModelSlug(
  model: string | null | undefined,
  provider: ProviderKind = "codex",
): string | null {
  if (typeof model !== "string") {
    return null;
  }

  const trimmed = model.trim();
  if (!trimmed) {
    return null;
  }

  const aliases = MODEL_SLUG_ALIASES_BY_PROVIDER[provider] as Record<string, string>;
  const aliased = Object.prototype.hasOwnProperty.call(aliases, trimmed)
    ? aliases[trimmed]
    : undefined;
  return typeof aliased === "string" ? aliased : trimmed;
}

export function resolveSelectableModel(
  provider: ProviderKind,
  value: string | null | undefined,
  options: ReadonlyArray<SelectableModelOption>,
): string | null {
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

function resolveModelSlug(model: string | null | undefined, provider: ProviderKind): string {
  const normalized = normalizeModelSlug(model, provider);
  if (!normalized) {
    return DEFAULT_MODEL_BY_PROVIDER[provider];
  }
  return normalized;
}

export function resolveModelSlugForProvider(
  provider: ProviderKind,
  model: string | null | undefined,
): string {
  return resolveModelSlug(model, provider);
}

/** Trim a string, returning null for empty/missing values. */
export function trimOrNull<T extends string>(value: T | null | undefined): T | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim() as T;
  return trimmed || null;
}

export function createModelSelection(
  provider: ProviderKind,
  model: string,
  options?: ProviderModelOptions[ProviderKind] | undefined,
): ModelSelection {
  switch (provider) {
    case "codex":
      return {
        provider,
        model,
        ...(options ? { options: options as CodexModelOptions } : {}),
      };
    case "claudeAgent":
      return {
        provider,
        model,
        ...(options ? { options: options as ClaudeModelOptions } : {}),
      };
    case "cursor":
      return {
        provider,
        model,
        ...(options ? { options: options as CursorModelOptions } : {}),
      };
    case "opencode":
      return {
        provider,
        model,
        ...(options ? { options: options as OpenCodeModelOptions } : {}),
      };
  }
}

export function applyClaudePromptEffortPrefix(
  text: string,
  effort: ClaudeAgentEffort | null | undefined,
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
