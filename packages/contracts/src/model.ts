import type { ProviderKind } from "./orchestration";

type ModelOption = {
  readonly slug: string;
  readonly name: string;
};

export const CURSOR_REASONING_OPTIONS = ["low", "normal", "high", "xhigh"] as const;
export type CursorReasoningOption = (typeof CURSOR_REASONING_OPTIONS)[number];

type CursorModelFamilyOption = {
  readonly slug: string;
  readonly name: string;
};

export const CURSOR_MODEL_FAMILY_OPTIONS = [
  { slug: "auto", name: "Auto" },
  { slug: "composer-1.5", name: "Composer 1.5" },
  { slug: "composer-1", name: "Composer 1" },
  { slug: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
  { slug: "gpt-5.3-codex-spark-preview", name: "GPT-5.3 Codex Spark" },
  { slug: "gpt-5.2-codex", name: "GPT-5.2 Codex" },
  { slug: "gpt-5.2", name: "GPT-5.2" },
  { slug: "gpt-5.2-high", name: "GPT-5.2 High" },
  { slug: "gpt-5.1-codex-max", name: "GPT-5.1 Codex Max" },
  { slug: "gpt-5.1-codex-mini", name: "GPT-5.1 Codex Mini" },
  { slug: "gpt-5.1-high", name: "GPT-5.1 High" },
  { slug: "opus-4.6", name: "Claude 4.6 Opus" },
  { slug: "opus-4.5", name: "Claude 4.5 Opus" },
  { slug: "sonnet-4.6", name: "Claude 4.6 Sonnet" },
  { slug: "sonnet-4.5", name: "Claude 4.5 Sonnet" },
  { slug: "gemini-3.1-pro", name: "Gemini 3.1 Pro" },
  { slug: "gemini-3-pro", name: "Gemini 3 Pro" },
  { slug: "gemini-3-flash", name: "Gemini 3 Flash" },
  { slug: "grok", name: "Grok" },
  { slug: "kimi-k2.5", name: "Kimi K2.5" },
] as const satisfies readonly CursorModelFamilyOption[];

export type CursorModelFamily = (typeof CURSOR_MODEL_FAMILY_OPTIONS)[number]["slug"];

export const MODEL_OPTIONS_BY_PROVIDER = {
  codex: [
    { slug: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
    { slug: "gpt-5.3-codex-spark", name: "GPT-5.3 Codex Spark" },
    { slug: "gpt-5.2-codex", name: "GPT-5.2 Codex" },
    { slug: "gpt-5.2", name: "GPT-5.2" },
  ],
  claudeCode: [
    { slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { slug: "claude-opus-4-6", name: "Claude Opus 4.6" },
    { slug: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
  ],
  cursor: [
    { slug: "auto", name: "Auto" },
    { slug: "composer-1.5", name: "Composer 1.5" },
    { slug: "composer-1", name: "Composer 1" },
    { slug: "gpt-5.3-codex-low", name: "GPT-5.3 Codex Low" },
    { slug: "gpt-5.3-codex-low-fast", name: "GPT-5.3 Codex Low Fast" },
    { slug: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
    { slug: "gpt-5.3-codex-fast", name: "GPT-5.3 Codex Fast" },
    { slug: "gpt-5.3-codex-high", name: "GPT-5.3 Codex High" },
    { slug: "gpt-5.3-codex-high-fast", name: "GPT-5.3 Codex High Fast" },
    { slug: "gpt-5.3-codex-xhigh", name: "GPT-5.3 Codex Extra High" },
    { slug: "gpt-5.3-codex-xhigh-fast", name: "GPT-5.3 Codex Extra High Fast" },
    { slug: "gpt-5.3-codex-spark-preview", name: "GPT-5.3 Codex Spark" },
    { slug: "gpt-5.2", name: "GPT-5.2" },
    { slug: "gpt-5.2-codex-low", name: "GPT-5.2 Codex Low" },
    { slug: "gpt-5.2-codex-low-fast", name: "GPT-5.2 Codex Low Fast" },
    { slug: "gpt-5.2-codex", name: "GPT-5.2 Codex" },
    { slug: "gpt-5.2-codex-fast", name: "GPT-5.2 Codex Fast" },
    { slug: "gpt-5.2-codex-high", name: "GPT-5.2 Codex High" },
    { slug: "gpt-5.2-codex-high-fast", name: "GPT-5.2 Codex High Fast" },
    { slug: "gpt-5.2-codex-xhigh", name: "GPT-5.2 Codex Extra High" },
    { slug: "gpt-5.2-codex-xhigh-fast", name: "GPT-5.2 Codex Extra High Fast" },
    { slug: "gpt-5.1-codex-max", name: "GPT-5.1 Codex Max" },
    { slug: "gpt-5.1-codex-max-high", name: "GPT-5.1 Codex Max High" },
    { slug: "gpt-5.2-high", name: "GPT-5.2 High" },
    { slug: "gpt-5.1-high", name: "GPT-5.1 High" },
    { slug: "gpt-5.1-codex-mini", name: "GPT-5.1 Codex Mini" },
    { slug: "opus-4.6-thinking", name: "Claude 4.6 Opus (Thinking)" },
    { slug: "opus-4.6", name: "Claude 4.6 Opus" },
    { slug: "opus-4.5", name: "Claude 4.5 Opus" },
    { slug: "opus-4.5-thinking", name: "Claude 4.5 Opus (Thinking)" },
    { slug: "sonnet-4.6", name: "Claude 4.6 Sonnet" },
    { slug: "gemini-3.1-pro", name: "Gemini 3.1 Pro" },
    { slug: "gemini-3-pro", name: "Gemini 3 Pro" },
    { slug: "sonnet-4.6-thinking", name: "Claude 4.6 Sonnet (Thinking)" },
    { slug: "sonnet-4.5", name: "Claude 4.5 Sonnet" },
    { slug: "sonnet-4.5-thinking", name: "Claude 4.5 Sonnet (Thinking)" },
    { slug: "gemini-3-flash", name: "Gemini 3 Flash" },
    { slug: "grok", name: "Grok" },
    { slug: "kimi-k2.5", name: "Kimi K2.5" },
  ],
} as const satisfies Record<ProviderKind, readonly ModelOption[]>;

export type ModelSlug = (typeof MODEL_OPTIONS_BY_PROVIDER)[ProviderKind][number]["slug"];
export type CursorModelSlug = (typeof MODEL_OPTIONS_BY_PROVIDER)["cursor"][number]["slug"];

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
  "gpt-5.2-codex": {
    supportsReasoning: true,
    supportsFast: true,
    supportsThinking: false,
    defaultReasoning: "normal",
    defaultThinking: false,
  },
  "gpt-5.2": {
    supportsReasoning: false,
    supportsFast: false,
    supportsThinking: false,
    defaultReasoning: "normal",
    defaultThinking: false,
  },
  "gpt-5.2-high": {
    supportsReasoning: false,
    supportsFast: false,
    supportsThinking: false,
    defaultReasoning: "normal",
    defaultThinking: false,
  },
  "gpt-5.1-codex-max": {
    supportsReasoning: false,
    supportsFast: false,
    supportsThinking: false,
    defaultReasoning: "normal",
    defaultThinking: false,
  },
  "gpt-5.1-codex-mini": {
    supportsReasoning: false,
    supportsFast: false,
    supportsThinking: false,
    defaultReasoning: "normal",
    defaultThinking: false,
  },
  "gpt-5.1-high": {
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
  "sonnet-4.5": {
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
  "gemini-3-pro": {
    supportsReasoning: false,
    supportsFast: false,
    supportsThinking: false,
    defaultReasoning: "normal",
    defaultThinking: false,
  },
  "gemini-3-flash": {
    supportsReasoning: false,
    supportsFast: false,
    supportsThinking: false,
    defaultReasoning: "normal",
    defaultThinking: false,
  },
  grok: {
    supportsReasoning: false,
    supportsFast: false,
    supportsThinking: false,
    defaultReasoning: "normal",
    defaultThinking: false,
  },
  "kimi-k2.5": {
    supportsReasoning: false,
    supportsFast: false,
    supportsThinking: false,
    defaultReasoning: "normal",
    defaultThinking: false,
  },
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

export const DEFAULT_MODEL_BY_PROVIDER: Record<ProviderKind, ModelSlug> = {
  codex: "gpt-5.3-codex",
  claudeCode: "claude-sonnet-4-6",
  cursor: "opus-4.6-thinking",
};

// Backward compatibility for existing Codex-only call sites.
export const MODEL_OPTIONS = MODEL_OPTIONS_BY_PROVIDER.codex;
export const DEFAULT_MODEL = DEFAULT_MODEL_BY_PROVIDER.codex;

export const MODEL_SLUG_ALIASES_BY_PROVIDER: Record<ProviderKind, Record<string, ModelSlug>> = {
  codex: {
    "5.3": "gpt-5.3-codex",
    "gpt-5.3": "gpt-5.3-codex",
    "5.3-spark": "gpt-5.3-codex-spark",
    "gpt-5.3-spark": "gpt-5.3-codex-spark",
  },
  claudeCode: {
    opus: "claude-opus-4-6",
    "opus-4.6": "claude-opus-4-6",
    "claude-opus-4.6": "claude-opus-4-6",
    "claude-opus-4-6-20251117": "claude-opus-4-6",
    sonnet: "claude-sonnet-4-6",
    "sonnet-4.6": "claude-sonnet-4-6",
    "claude-sonnet-4.6": "claude-sonnet-4-6",
    "claude-sonnet-4-6-20251117": "claude-sonnet-4-6",
    haiku: "claude-haiku-4-5",
    "haiku-4.5": "claude-haiku-4-5",
    "claude-haiku-4.5": "claude-haiku-4-5",
    "claude-haiku-4-5-20251001": "claude-haiku-4-5",
  },
  cursor: {
    composer: "composer-1.5",
    "composer-1.5": "composer-1.5",
    "composer-1": "composer-1",
    "gpt-5.3-codex": "gpt-5.3-codex",
    "gpt-5.3-codex-spark": "gpt-5.3-codex-spark-preview",
    "gpt-5.2-codex": "gpt-5.2-codex",
    "gpt-5.1-codex-max-high": "gpt-5.1-codex-max-high",
    "gpt-5.1-codex-mini": "gpt-5.1-codex-mini",
    "gemini-3.1": "gemini-3.1-pro",
    "gemini-3.1-pro": "gemini-3.1-pro",
    "gemini-3-pro": "gemini-3-pro",
    "claude-4.6-sonnet-thinking": "sonnet-4.6-thinking",
    "claude-4.5-sonnet-thinking": "sonnet-4.5-thinking",
    "claude-4.6-opus-thinking": "opus-4.6-thinking",
    "claude-4.5-opus-thinking": "opus-4.5-thinking",
    "sonnet-4.6-thinking": "sonnet-4.6-thinking",
    "sonnet-4.5-thinking": "sonnet-4.5-thinking",
    "opus-4.6-thinking": "opus-4.6-thinking",
    "opus-4.5-thinking": "opus-4.5-thinking",
  },
};

const MODEL_SLUG_SET_BY_PROVIDER: Record<ProviderKind, ReadonlySet<ModelSlug>> = {
  claudeCode: new Set(MODEL_OPTIONS_BY_PROVIDER.claudeCode.map((option) => option.slug)),
  codex: new Set(MODEL_OPTIONS_BY_PROVIDER.codex.map((option) => option.slug)),
  cursor: new Set(MODEL_OPTIONS_BY_PROVIDER.cursor.map((option) => option.slug)),
};

export function getModelOptions(provider: ProviderKind = "codex") {
  return MODEL_OPTIONS_BY_PROVIDER[provider];
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

  if (
    normalized === "gpt-5.2-codex" ||
    normalized === "gpt-5.2-codex-fast" ||
    normalized === "gpt-5.2-codex-low" ||
    normalized === "gpt-5.2-codex-low-fast" ||
    normalized === "gpt-5.2-codex-high" ||
    normalized === "gpt-5.2-codex-high-fast" ||
    normalized === "gpt-5.2-codex-xhigh" ||
    normalized === "gpt-5.2-codex-xhigh-fast"
  ) {
    return "gpt-5.2-codex";
  }

  if (normalized === "sonnet-4.6-thinking") {
    return "sonnet-4.6";
  }
  if (normalized === "sonnet-4.5-thinking") {
    return "sonnet-4.5";
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

  return MODEL_SLUG_ALIASES_BY_PROVIDER[provider][trimmed] ?? (trimmed as ModelSlug);
}

export function resolveModelSlug(
  model: string | null | undefined,
  provider: ProviderKind = "codex",
): ModelSlug {
  const normalized = normalizeModelSlug(model, provider);
  if (!normalized) {
    return DEFAULT_MODEL_BY_PROVIDER[provider];
  }

  return MODEL_SLUG_SET_BY_PROVIDER[provider].has(normalized)
    ? normalized
    : DEFAULT_MODEL_BY_PROVIDER[provider];
}

export function resolveModelSlugForProvider(
  provider: ProviderKind,
  model: string | null | undefined,
): ModelSlug {
  return resolveModelSlug(model, provider);
}

const CODEX_REASONING_EFFORT_OPTIONS = ["xhigh", "high", "medium", "low"] as const;
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORT_OPTIONS)[number];

export const REASONING_EFFORT_OPTIONS_BY_PROVIDER = {
  codex: CODEX_REASONING_EFFORT_OPTIONS,
  claudeCode: [],
  cursor: [],
} as const satisfies Record<ProviderKind, readonly CodexReasoningEffort[]>;

export const DEFAULT_REASONING_EFFORT_BY_PROVIDER = {
  codex: "high",
  claudeCode: null,
  cursor: null,
} as const satisfies Record<ProviderKind, CodexReasoningEffort | null>;

export function getReasoningEffortOptions(
  provider: ProviderKind = "codex",
): ReadonlyArray<CodexReasoningEffort> {
  return REASONING_EFFORT_OPTIONS_BY_PROVIDER[provider];
}

export function getDefaultReasoningEffort(provider: "codex"): CodexReasoningEffort;
export function getDefaultReasoningEffort(provider: ProviderKind): CodexReasoningEffort | null;
export function getDefaultReasoningEffort(
  provider: ProviderKind = "codex",
): CodexReasoningEffort | null {
  return DEFAULT_REASONING_EFFORT_BY_PROVIDER[provider];
}
