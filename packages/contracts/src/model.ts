import { Schema } from "effect";
import type { ProviderKind } from "./orchestration";

export const CURSOR_REASONING_OPTIONS = ["low", "normal", "high", "xhigh"] as const;
export type CursorReasoningOption = (typeof CURSOR_REASONING_OPTIONS)[number];

export const CODEX_REASONING_EFFORT_OPTIONS = ["xhigh", "high", "medium", "low"] as const;
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORT_OPTIONS)[number];

export const CLAUDE_CODE_EFFORT_OPTIONS = ["low", "medium", "high", "max"] as const;
export type ClaudeCodeEffort = (typeof CLAUDE_CODE_EFFORT_OPTIONS)[number];

export const CodexModelOptions = Schema.Struct({
  reasoningEffort: Schema.optional(Schema.Literals(CODEX_REASONING_EFFORT_OPTIONS)),
  fastMode: Schema.optional(Schema.Boolean),
});
export type CodexModelOptions = typeof CodexModelOptions.Type;

export const CopilotModelOptions = Schema.Struct({
  reasoningEffort: Schema.optional(Schema.Literals(CODEX_REASONING_EFFORT_OPTIONS)),
});
export type CopilotModelOptions = typeof CopilotModelOptions.Type;

export const OpencodeModelOptions = Schema.Struct({
  providerId: Schema.optional(Schema.String),
  modelId: Schema.optional(Schema.String),
  variant: Schema.optional(Schema.String),
  reasoningEffort: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
});
export type OpencodeModelOptions = typeof OpencodeModelOptions.Type;

export const ClaudeCodeModelOptions = Schema.Struct({
  thinking: Schema.optional(Schema.Boolean),
  effort: Schema.optional(Schema.Literals(CLAUDE_CODE_EFFORT_OPTIONS)),
});
export type ClaudeCodeModelOptions = typeof ClaudeCodeModelOptions.Type;

export const CursorModelOptions = Schema.Struct({
  reasoning: Schema.optional(Schema.Literals(CURSOR_REASONING_OPTIONS)),
  fastMode: Schema.optional(Schema.Boolean),
  thinking: Schema.optional(Schema.Boolean),
});
export type CursorModelOptions = typeof CursorModelOptions.Type;

export const GeminiCliModelOptions = Schema.Struct({
  thinkingBudget: Schema.optional(Schema.Number),
});
export type GeminiCliModelOptions = typeof GeminiCliModelOptions.Type;

export const AmpModelOptions = Schema.Struct({
  mode: Schema.optional(Schema.Literals(["smart", "rush", "deep"])),
});
export type AmpModelOptions = typeof AmpModelOptions.Type;

export const KiloModelOptions = Schema.Struct({
  providerId: Schema.optional(Schema.String),
  modelId: Schema.optional(Schema.String),
  variant: Schema.optional(Schema.String),
  reasoningEffort: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
});
export type KiloModelOptions = typeof KiloModelOptions.Type;

export const ProviderModelOptions = Schema.Struct({
  codex: Schema.optional(CodexModelOptions),
  copilot: Schema.optional(CopilotModelOptions),
  claudeCode: Schema.optional(ClaudeCodeModelOptions),
  cursor: Schema.optional(CursorModelOptions),
  opencode: Schema.optional(OpencodeModelOptions),
  geminiCli: Schema.optional(GeminiCliModelOptions),
  amp: Schema.optional(AmpModelOptions),
  kilo: Schema.optional(KiloModelOptions),
});
export type ProviderModelOptions = typeof ProviderModelOptions.Type;

type ModelOption = {
  readonly slug: string;
  readonly name: string;
  readonly pricingTier?: string;
};

type CursorModelFamilyOption = {
  readonly slug: string;
  readonly name: string;
};

export const CURSOR_MODEL_FAMILY_OPTIONS = [
  { slug: "auto", name: "Auto" },
  { slug: "composer-1.5", name: "Composer 1.5" },
  { slug: "composer-1", name: "Composer 1" },
  { slug: "gpt-5.4-medium", name: "GPT-5.4" },
  { slug: "gpt-5.4-medium-fast", name: "GPT-5.4 Fast" },
  { slug: "gpt-5.4-high", name: "GPT-5.4 High" },
  { slug: "gpt-5.4-high-fast", name: "GPT-5.4 High Fast" },
  { slug: "gpt-5.4-xhigh", name: "GPT-5.4 Extra High" },
  { slug: "gpt-5.4-xhigh-fast", name: "GPT-5.4 Extra High Fast" },
  { slug: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
  { slug: "gpt-5.3-codex-spark-preview", name: "GPT-5.3 Codex Spark" },
  { slug: "gpt-5.2-codex", name: "GPT-5.2 Codex" },
  { slug: "gpt-5.2", name: "GPT-5.2" },
  { slug: "gpt-5.2-high", name: "GPT-5.2 High" },
  { slug: "gpt-5.1-codex-max", name: "GPT-5.1 Codex Max" },
  { slug: "gpt-5.1-codex-max-high", name: "GPT-5.1 Codex Max High" },
  { slug: "gpt-5.1-high", name: "GPT-5.1 High" },
  { slug: "gpt-5.1-codex-mini", name: "GPT-5.1 Codex Mini" },
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
    { slug: "gpt-5.4", name: "GPT-5.4" },
    { slug: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
    { slug: "gpt-5.3-codex-spark", name: "GPT-5.3 Codex Spark" },
    { slug: "gpt-5.2-codex", name: "GPT-5.2 Codex" },
    { slug: "gpt-5.2", name: "GPT-5.2" },
  ],
  copilot: [
    { slug: "gpt-5.4", name: "GPT-5.4" },
    { slug: "claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
    { slug: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
    { slug: "claude-haiku-4.5", name: "Claude Haiku 4.5" },
    { slug: "claude-opus-4.6", name: "Claude Opus 4.6" },
    { slug: "claude-opus-4.6-fast", name: "Claude Opus 4.6 (fast mode)" },
    { slug: "claude-opus-4.5", name: "Claude Opus 4.5" },
    { slug: "claude-sonnet-4", name: "Claude Sonnet 4" },
    { slug: "gemini-3-pro-preview", name: "Gemini 3 Pro (Preview)" },
    { slug: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
    { slug: "gpt-5.2-codex", name: "GPT-5.2 Codex" },
    { slug: "gpt-5.2", name: "GPT-5.2" },
    { slug: "gpt-5.1-codex-max", name: "GPT-5.1 Codex Max" },
    { slug: "gpt-5.1-codex", name: "GPT-5.1 Codex" },
    { slug: "gpt-5.1-codex-mini", name: "GPT-5.1 Codex Mini" },
    { slug: "gpt-5.1", name: "GPT-5.1" },
    { slug: "gpt-5-mini", name: "GPT-5 mini" },
    { slug: "gpt-4.1", name: "GPT-4.1" },
  ],
  claudeCode: [
    { slug: "claude-opus-4-6", name: "Claude Opus 4.6" },
    { slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
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
    { slug: "gpt-5.2", name: "GPT-5.2" },
    { slug: "gpt-5.3-codex-spark-preview", name: "GPT-5.3 Codex Spark" },
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
    { slug: "gpt-5.4-high", name: "GPT-5.4 High" },
    { slug: "opus-4.6", name: "Claude 4.6 Opus" },
    { slug: "opus-4.6-thinking", name: "Claude 4.6 Opus (Thinking)" },
    { slug: "gpt-5.4-medium", name: "GPT-5.4" },
    { slug: "gpt-5.4-medium-fast", name: "GPT-5.4 Fast" },
    { slug: "gpt-5.4-high-fast", name: "GPT-5.4 High Fast" },
    { slug: "gpt-5.4-xhigh", name: "GPT-5.4 Extra High" },
    { slug: "gpt-5.4-xhigh-fast", name: "GPT-5.4 Extra High Fast" },
    { slug: "opus-4.5", name: "Claude 4.5 Opus" },
    { slug: "opus-4.5-thinking", name: "Claude 4.5 Opus (Thinking)" },
    { slug: "sonnet-4.6", name: "Claude 4.6 Sonnet" },
    { slug: "sonnet-4.6-thinking", name: "Claude 4.6 Sonnet (Thinking)" },
    { slug: "gpt-5.2-high", name: "GPT-5.2 High" },
    { slug: "gemini-3.1-pro", name: "Gemini 3.1 Pro" },
    { slug: "grok", name: "Grok" },
    { slug: "sonnet-4.5", name: "Claude 4.5 Sonnet" },
    { slug: "sonnet-4.5-thinking", name: "Claude 4.5 Sonnet (Thinking)" },
    { slug: "gpt-5.1-high", name: "GPT-5.1 High" },
    { slug: "gemini-3-pro", name: "Gemini 3 Pro" },
    { slug: "gemini-3-flash", name: "Gemini 3 Flash" },
    { slug: "gpt-5.1-codex-mini", name: "GPT-5.1 Codex Mini" },
    { slug: "kimi-k2.5", name: "Kimi K2.5" },
  ],
  opencode: [] as ModelOption[],
  geminiCli: [
    { slug: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    { slug: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
    { slug: "gemini-3-pro-preview", name: "Gemini 3 Pro" },
    { slug: "gemini-3-flash-preview", name: "Gemini 3 Flash" },
    { slug: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro" },
  ],
  amp: [
    { slug: "smart", name: "Smart (Opus 4.6)" },
    { slug: "rush", name: "Rush (Fast)" },
    { slug: "deep", name: "Deep (GPT-5.3 Codex)" },
  ],
  kilo: [] as ModelOption[],
} as const satisfies Record<ProviderKind, readonly ModelOption[]>;
export type ModelOptionsByProvider = typeof MODEL_OPTIONS_BY_PROVIDER;

type BuiltInModelSlug = ModelOptionsByProvider[ProviderKind][number]["slug"];
export type ModelSlug = BuiltInModelSlug | (string & {});
export type CursorModelSlug = (typeof MODEL_OPTIONS_BY_PROVIDER)["cursor"][number]["slug"];

export const DEFAULT_MODEL_BY_PROVIDER = {
  codex: "gpt-5.4",
  copilot: "claude-sonnet-4.6",
  claudeCode: "claude-sonnet-4-6",
  cursor: "opus-4.6-thinking",
  opencode: "gpt-5",
  geminiCli: "gemini-2.5-pro",
  amp: "smart",
  kilo: "gpt-5",
} as const satisfies Record<ProviderKind, ModelSlug>;

// Backward compatibility for existing Codex-only call sites.
export const MODEL_OPTIONS = MODEL_OPTIONS_BY_PROVIDER.codex;
export const DEFAULT_MODEL = DEFAULT_MODEL_BY_PROVIDER.codex;

export const MODEL_SLUG_ALIASES_BY_PROVIDER: Record<ProviderKind, Record<string, ModelSlug>> = {
  codex: {
    "5.4": "gpt-5.4",
    "5.3": "gpt-5.3-codex",
    "gpt-5.3": "gpt-5.3-codex",
    "5.3-spark": "gpt-5.3-codex-spark",
    "gpt-5.3-spark": "gpt-5.3-codex-spark",
  },
  copilot: {
    "4.1": "gpt-4.1",
    "5.4": "gpt-5.4",
    "5-mini": "gpt-5-mini",
    "5.1": "gpt-5.1",
    "5.1-codex": "gpt-5.1-codex",
    "5.1-max": "gpt-5.1-codex-max",
    "5.1-mini": "gpt-5.1-codex-mini",
    "5.2": "gpt-5.2",
    "5.2-codex": "gpt-5.2-codex",
    "5.3": "gpt-5.3-codex",
    haiku: "claude-haiku-4.5",
    sonnet: "claude-sonnet-4.6",
    opus: "claude-opus-4.6",
    gemini: "gemini-3-pro-preview",
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
    "5.4": "gpt-5.4-medium",
    "gpt-5.4": "gpt-5.4-medium",
    "5.2": "gpt-5.2",
    "5.2-codex": "gpt-5.2-codex",
    "gpt-5.2-codex": "gpt-5.2-codex",
    "5.1-max": "gpt-5.1-codex-max",
    "gpt-5.1-codex-max": "gpt-5.1-codex-max",
    "gpt-5.3-codex": "gpt-5.3-codex",
    "gpt-5.3-codex-spark": "gpt-5.3-codex-spark-preview",
    "gemini-3.1": "gemini-3.1-pro",
    "gemini-3.1-pro": "gemini-3.1-pro",
    "claude-4.6-sonnet-thinking": "sonnet-4.6-thinking",
    "claude-4.5-sonnet-thinking": "sonnet-4.5-thinking",
    "claude-4.6-opus-thinking": "opus-4.6-thinking",
    "claude-4.5-opus-thinking": "opus-4.5-thinking",
    "sonnet-4.5-thinking": "sonnet-4.5-thinking",
    "sonnet-4.6-thinking": "sonnet-4.6-thinking",
    "opus-4.6-thinking": "opus-4.6-thinking",
    "opus-4.5-thinking": "opus-4.5-thinking",
  },
  opencode: {},
  kilo: {},
  geminiCli: {
    gemini: "gemini-2.5-pro",
    "2.5-pro": "gemini-2.5-pro",
    "2.5-flash": "gemini-2.5-flash",
    "3-pro": "gemini-3-pro-preview",
    "3-flash": "gemini-3-flash-preview",
    "3.1-pro": "gemini-3.1-pro-preview",
    // Compatibility aliases for old slugs without -preview suffix
    "gemini-3-pro": "gemini-3-pro-preview",
    "gemini-3-flash": "gemini-3-flash-preview",
    "gemini-3.1-pro": "gemini-3.1-pro-preview",
  },
  amp: {
    opus: "smart",
    fast: "rush",
    codex: "deep",
  },
};

export const REASONING_EFFORT_OPTIONS_BY_PROVIDER = {
  codex: CODEX_REASONING_EFFORT_OPTIONS,
  copilot: [],
  claudeCode: [],
  cursor: [],
  opencode: [],
  kilo: [],
  geminiCli: [],
  amp: [],
} as const satisfies Record<ProviderKind, readonly CodexReasoningEffort[]>;

export const DEFAULT_REASONING_EFFORT_BY_PROVIDER = {
  codex: "high",
  copilot: null,
  claudeCode: null,
  cursor: null,
  opencode: null,
  kilo: null,
  geminiCli: null,
  amp: null,
} as const satisfies Record<ProviderKind, CodexReasoningEffort | null>;

export const CLAUDE_CODE_EFFORT_OPTIONS_BY_PROVIDER = {
  codex: [],
  copilot: [],
  claudeCode: CLAUDE_CODE_EFFORT_OPTIONS,
  cursor: [],
  opencode: [],
  kilo: [],
  geminiCli: [],
  amp: [],
} as const satisfies Record<ProviderKind, readonly ClaudeCodeEffort[]>;

export const DEFAULT_CLAUDE_CODE_EFFORT_BY_PROVIDER = {
  codex: null,
  copilot: null,
  claudeCode: "high",
  cursor: null,
  opencode: null,
  kilo: null,
  geminiCli: null,
  amp: null,
} as const satisfies Record<ProviderKind, ClaudeCodeEffort | null>;
