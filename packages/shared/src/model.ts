import {
  CODEX_REASONING_EFFORT_OPTIONS,
  CURSOR_MODEL_FAMILY_OPTIONS,
  CURSOR_REASONING_OPTIONS,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  MODEL_OPTIONS_BY_PROVIDER,
  MODEL_SLUG_ALIASES_BY_PROVIDER,
  type CodexReasoningEffort,
  type CursorModelFamily,
  type CursorModelSlug,
  type CursorReasoningOption,
  type ModelSlug,
  type ProviderKind,
} from "../../contracts/src";

type CatalogProvider = keyof typeof MODEL_OPTIONS_BY_PROVIDER;

type CursorModelCapability = {
  readonly supportsReasoning: boolean;
  readonly supportsFast: boolean;
  readonly supportsThinking: boolean;
  readonly defaultReasoning: CursorReasoningOption;
  readonly defaultThinking: boolean;
};

const CURSOR_MODEL_CAPABILITY_BY_FAMILY: Record<CursorModelFamily, CursorModelCapability> = {
  auto: {
    supportsReasoning: false,
    supportsFast: false,
    supportsThinking: false,
    defaultReasoning: "normal",
    defaultThinking: false,
  },
  "composer-1.5": {
    supportsReasoning: false,
    supportsFast: false,
    supportsThinking: false,
    defaultReasoning: "normal",
    defaultThinking: false,
  },
  "composer-1": {
    supportsReasoning: false,
    supportsFast: false,
    supportsThinking: false,
    defaultReasoning: "normal",
    defaultThinking: false,
  },
  "gpt-5.3-codex": {
    supportsReasoning: true,
    supportsFast: true,
    supportsThinking: false,
    defaultReasoning: "normal",
    defaultThinking: false,
  },
  "gpt-5.3-codex-spark-preview": {
    supportsReasoning: false,
    supportsFast: false,
    supportsThinking: false,
    defaultReasoning: "normal",
    defaultThinking: false,
  },
  "opus-4.6": {
    supportsReasoning: false,
    supportsFast: false,
    supportsThinking: true,
    defaultReasoning: "normal",
    defaultThinking: true,
  },
  "opus-4.5": {
    supportsReasoning: false,
    supportsFast: false,
    supportsThinking: true,
    defaultReasoning: "normal",
    defaultThinking: true,
  },
  "sonnet-4.6": {
    supportsReasoning: false,
    supportsFast: false,
    supportsThinking: true,
    defaultReasoning: "normal",
    defaultThinking: true,
  },
  "gemini-3.1-pro": {
    supportsReasoning: false,
    supportsFast: false,
    supportsThinking: false,
    defaultReasoning: "normal",
    defaultThinking: false,
  },
};

function hasModelCatalog(provider: ProviderKind): provider is CatalogProvider {
  return Object.hasOwn(MODEL_OPTIONS_BY_PROVIDER, provider);
}

const MODEL_SLUG_SET_BY_PROVIDER: Record<CatalogProvider, ReadonlySet<ModelSlug>> = {
  codex: new Set(MODEL_OPTIONS_BY_PROVIDER.codex.map((option) => option.slug)),
  cursor: new Set(MODEL_OPTIONS_BY_PROVIDER.cursor.map((option) => option.slug)),
};

const CURSOR_MODEL_FAMILY_SET = new Set<CursorModelFamily>(
  CURSOR_MODEL_FAMILY_OPTIONS.map((option) => option.slug),
);

export interface CursorModelSelection {
  readonly family: CursorModelFamily;
  readonly reasoning: CursorReasoningOption;
  readonly fast: boolean;
  readonly thinking: boolean;
}

export function getModelOptions(provider: ProviderKind = "codex") {
  return hasModelCatalog(provider) ? MODEL_OPTIONS_BY_PROVIDER[provider] : [];
}

export function getCursorModelFamilyOptions() {
  return CURSOR_MODEL_FAMILY_OPTIONS;
}

export function getCursorModelCapabilities(family: CursorModelFamily) {
  return CURSOR_MODEL_CAPABILITY_BY_FAMILY[family];
}

function fallbackCursorModelFamily(): CursorModelFamily {
  const fallback = parseCursorModelSelection(DEFAULT_MODEL_BY_PROVIDER.cursor);
  return fallback.family;
}

function resolveCursorModelFamily(model: string | null | undefined): CursorModelFamily {
  const normalized = normalizeModelSlug(model, "cursor");
  if (!normalized) {
    return fallbackCursorModelFamily();
  }

  if (
    normalized === "gpt-5.3-codex" ||
    normalized === "gpt-5.3-codex-fast" ||
    normalized === "gpt-5.3-codex-low" ||
    normalized === "gpt-5.3-codex-low-fast" ||
    normalized === "gpt-5.3-codex-high" ||
    normalized === "gpt-5.3-codex-high-fast" ||
    normalized === "gpt-5.3-codex-xhigh" ||
    normalized === "gpt-5.3-codex-xhigh-fast"
  ) {
    return "gpt-5.3-codex";
  }

  if (normalized === "sonnet-4.6-thinking") {
    return "sonnet-4.6";
  }
  if (normalized === "opus-4.6-thinking") {
    return "opus-4.6";
  }
  if (normalized === "opus-4.5-thinking") {
    return "opus-4.5";
  }

  return CURSOR_MODEL_FAMILY_SET.has(normalized as CursorModelFamily)
    ? (normalized as CursorModelFamily)
    : fallbackCursorModelFamily();
}

function resolveCursorReasoning(model: CursorModelSlug): CursorReasoningOption {
  if (model.includes("-xhigh")) return "xhigh";
  if (model.includes("-high")) return "high";
  if (model.includes("-low")) return "low";
  return "normal";
}

export function parseCursorModelSelection(model: string | null | undefined): CursorModelSelection {
  const family = resolveCursorModelFamily(model);
  const capability = CURSOR_MODEL_CAPABILITY_BY_FAMILY[family];
  const normalized = resolveModelSlugForProvider("cursor", model) as CursorModelSlug;

  if (capability.supportsReasoning) {
    return {
      family,
      reasoning: resolveCursorReasoning(normalized),
      fast: normalized.endsWith("-fast"),
      thinking: false,
    };
  }

  if (capability.supportsThinking) {
    return {
      family,
      reasoning: capability.defaultReasoning,
      fast: false,
      thinking: normalized.endsWith("-thinking"),
    };
  }

  return {
    family,
    reasoning: capability.defaultReasoning,
    fast: false,
    thinking: capability.defaultThinking,
  };
}

export function resolveCursorModelFromSelection(input: {
  readonly family: CursorModelFamily;
  readonly reasoning?: CursorReasoningOption | null;
  readonly fast?: boolean;
  readonly thinking?: boolean;
}): CursorModelSlug {
  const family = resolveCursorModelFamily(input.family);
  const capability = CURSOR_MODEL_CAPABILITY_BY_FAMILY[family];

  if (capability.supportsReasoning) {
    const reasoning = CURSOR_REASONING_OPTIONS.includes(input.reasoning ?? "normal")
      ? (input.reasoning ?? "normal")
      : capability.defaultReasoning;
    const reasoningSuffix = reasoning === "normal" ? "" : `-${reasoning}`;
    const fastSuffix = input.fast ? "-fast" : "";
    const candidate = `${family}${reasoningSuffix}${fastSuffix}`;
    return resolveModelSlugForProvider("cursor", candidate) as CursorModelSlug;
  }

  if (capability.supportsThinking) {
    const candidate = input.thinking ? `${family}-thinking` : family;
    return resolveModelSlugForProvider("cursor", candidate) as CursorModelSlug;
  }

  return resolveModelSlugForProvider("cursor", family) as CursorModelSlug;
}

export function getDefaultModel(provider: ProviderKind = "codex"): ModelSlug {
  return hasModelCatalog(provider) ? DEFAULT_MODEL_BY_PROVIDER[provider] : DEFAULT_MODEL;
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

  if (!hasModelCatalog(provider)) {
    return trimmed as ModelSlug;
  }

  const aliases = MODEL_SLUG_ALIASES_BY_PROVIDER[provider] as Record<string, ModelSlug>;
  return aliases[trimmed] ?? (trimmed as ModelSlug);
}

export function resolveModelSlug(
  model: string | null | undefined,
  provider: ProviderKind = "codex",
): ModelSlug {
  const normalized = normalizeModelSlug(model, provider);
  if (!normalized) {
    return getDefaultModel(provider);
  }

  if (!hasModelCatalog(provider)) {
    return getDefaultModel(provider);
  }

  return MODEL_SLUG_SET_BY_PROVIDER[provider].has(normalized) ? normalized : getDefaultModel(provider);
}

export function resolveModelSlugForProvider(
  provider: ProviderKind,
  model: string | null | undefined,
): ModelSlug {
  return resolveModelSlug(model, provider);
}

export function getReasoningEffortOptions(
  provider: ProviderKind = "codex",
): ReadonlyArray<CodexReasoningEffort> {
  return provider === "codex" ? CODEX_REASONING_EFFORT_OPTIONS : [];
}

export function getDefaultReasoningEffort(provider: "codex"): CodexReasoningEffort;
export function getDefaultReasoningEffort(provider: ProviderKind): CodexReasoningEffort | null;
export function getDefaultReasoningEffort(
  provider: ProviderKind = "codex",
): CodexReasoningEffort | null {
  return provider === "codex" ? "high" : null;
}

export { CODEX_REASONING_EFFORT_OPTIONS };
