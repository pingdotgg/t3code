import {
  DEFAULT_REASONING_EFFORT_BY_PROVIDER,
  CODEX_REASONING_EFFORT_OPTIONS,
  REASONING_EFFORT_OPTIONS_BY_PROVIDER,
  DEFAULT_MODEL_BY_PROVIDER,
  MODEL_OPTIONS_BY_PROVIDER,
  MODEL_SLUG_ALIASES_BY_PROVIDER,
  type ModelSlug,
  type ProviderKind,
  type ReasoningEffort,
} from "@t3tools/contracts";

type CatalogProvider = keyof typeof MODEL_OPTIONS_BY_PROVIDER;

const MODEL_SLUG_SET_BY_PROVIDER: Record<CatalogProvider, ReadonlySet<ModelSlug>> = {
  codex: new Set(MODEL_OPTIONS_BY_PROVIDER.codex.map((option) => option.slug)),
  claudeCode: new Set(MODEL_OPTIONS_BY_PROVIDER.claudeCode.map((option) => option.slug)),
};

export function getModelOptions(provider: ProviderKind = "codex") {
  return MODEL_OPTIONS_BY_PROVIDER[provider];
}

export function getDefaultModel(provider: ProviderKind = "codex"): ModelSlug {
  return DEFAULT_MODEL_BY_PROVIDER[provider];
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
  const aliased = aliases[trimmed];
  return typeof aliased === "string" ? aliased : (trimmed as ModelSlug);
}

export function resolveModelSlug(
  model: string | null | undefined,
  provider: ProviderKind = "codex",
): ModelSlug {
  const normalized = normalizeModelSlug(model, provider);
  if (!normalized) {
    return getDefaultModel(provider);
  }

  return MODEL_SLUG_SET_BY_PROVIDER[provider].has(normalized)
    ? normalized
    : getDefaultModel(provider);
}

export function resolveModelSlugForProvider(
  provider: ProviderKind,
  model: string | null | undefined,
): ModelSlug {
  return resolveModelSlug(model, provider);
}

export function getReasoningEffortOptions(
  provider: ProviderKind = "codex",
): ReadonlyArray<ReasoningEffort> {
  return REASONING_EFFORT_OPTIONS_BY_PROVIDER[provider];
}

export function getDefaultReasoningEffort(provider: "codex"): ReasoningEffort;
export function getDefaultReasoningEffort(provider: ProviderKind): ReasoningEffort | null;
export function getDefaultReasoningEffort(
  provider: ProviderKind = "codex",
): ReasoningEffort | null {
  return DEFAULT_REASONING_EFFORT_BY_PROVIDER[provider];
}

export function resolveReasoningEffortForProvider(
  provider: ProviderKind,
  effort: string | null | undefined,
): ReasoningEffort | null {
  if (typeof effort === "string") {
    const trimmed = effort.trim();
    const options = REASONING_EFFORT_OPTIONS_BY_PROVIDER[provider] as ReadonlyArray<string>;
    if (options.includes(trimmed)) {
      return trimmed as ReasoningEffort;
    }
  }

  return DEFAULT_REASONING_EFFORT_BY_PROVIDER[provider];
}

export function supportsReasoningEffortForModel(
  provider: ProviderKind,
  model: string | null | undefined,
): boolean {
  if (provider === "codex") {
    return CODEX_REASONING_EFFORT_OPTIONS.length > 0;
  }

  const normalized = normalizeModelSlug(model, "claudeCode");
  if (normalized === "sonnet" || normalized === "opus") {
    return true;
  }

  const trimmed = model?.trim().toLowerCase();
  if (!trimmed) {
    return false;
  }

  return (
    /^claude-(sonnet|opus)-4-6(?:\[[^\]]+\])?$/.test(trimmed) ||
    /^(sonnet|opus)(?:\[[^\]]+\])?$/.test(trimmed)
  );
}

export { CODEX_REASONING_EFFORT_OPTIONS };
