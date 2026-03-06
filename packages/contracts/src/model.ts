import { Schema } from "effect";

export const CURSOR_REASONING_OPTIONS = ["low", "normal", "high", "xhigh"] as const;
export type CursorReasoningOption = (typeof CURSOR_REASONING_OPTIONS)[number];

export const CODEX_REASONING_EFFORT_OPTIONS = ["xhigh", "high", "medium", "low"] as const;
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORT_OPTIONS)[number];

export const CodexModelOptions = Schema.Struct({
  reasoningEffort: Schema.optional(Schema.Literals(CODEX_REASONING_EFFORT_OPTIONS)),
  fastMode: Schema.optional(Schema.Boolean),
});
export type CodexModelOptions = typeof CodexModelOptions.Type;

export const CursorModelOptions = Schema.Struct({
  reasoning: Schema.optional(Schema.Literals(CURSOR_REASONING_OPTIONS)),
  fastMode: Schema.optional(Schema.Boolean),
  thinking: Schema.optional(Schema.Boolean),
});
export type CursorModelOptions = typeof CursorModelOptions.Type;

export const ProviderModelOptions = Schema.Struct({
  codex: Schema.optional(CodexModelOptions),
  cursor: Schema.optional(CursorModelOptions),
});
export type ProviderModelOptions = typeof ProviderModelOptions.Type;

type ModelOption = {
  readonly slug: string;
  readonly name: string;
};

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
  { slug: "opus-4.6", name: "Claude 4.6 Opus" },
  { slug: "opus-4.5", name: "Claude 4.5 Opus" },
  { slug: "sonnet-4.6", name: "Claude 4.6 Sonnet" },
  { slug: "gemini-3.1-pro", name: "Gemini 3.1 Pro" },
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
    { slug: "opus-4.6", name: "Claude 4.6 Opus" },
    { slug: "opus-4.6-thinking", name: "Claude 4.6 Opus (Thinking)" },
    { slug: "opus-4.5", name: "Claude 4.5 Opus" },
    { slug: "opus-4.5-thinking", name: "Claude 4.5 Opus (Thinking)" },
    { slug: "sonnet-4.6", name: "Claude 4.6 Sonnet" },
    { slug: "sonnet-4.6-thinking", name: "Claude 4.6 Sonnet (Thinking)" },
    { slug: "gemini-3.1-pro", name: "Gemini 3.1 Pro" },
  ],
} as const satisfies Record<"codex" | "cursor", readonly ModelOption[]>;

type BuiltInModelSlug =
  (typeof MODEL_OPTIONS_BY_PROVIDER)[keyof typeof MODEL_OPTIONS_BY_PROVIDER][number]["slug"];
export type ModelSlug = BuiltInModelSlug | (string & {});
export type CursorModelSlug = (typeof MODEL_OPTIONS_BY_PROVIDER)["cursor"][number]["slug"];

export const DEFAULT_MODEL_BY_PROVIDER = {
  codex: "gpt-5.3-codex",
  cursor: "opus-4.6-thinking",
} as const satisfies Record<keyof typeof MODEL_OPTIONS_BY_PROVIDER, ModelSlug>;

// Backward compatibility for existing Codex-only call sites.
export const MODEL_OPTIONS = MODEL_OPTIONS_BY_PROVIDER.codex;
export const DEFAULT_MODEL = DEFAULT_MODEL_BY_PROVIDER.codex;

export const MODEL_SLUG_ALIASES_BY_PROVIDER = {
  codex: {
    "5.4": "gpt-5.4",
    "5.3": "gpt-5.3-codex",
    "gpt-5.3": "gpt-5.3-codex",
    "5.3-spark": "gpt-5.3-codex-spark",
    "gpt-5.3-spark": "gpt-5.3-codex-spark",
  },
  cursor: {
    composer: "composer-1.5",
    "composer-1.5": "composer-1.5",
    "composer-1": "composer-1",
    "gpt-5.3-codex": "gpt-5.3-codex",
    "gpt-5.3-codex-spark": "gpt-5.3-codex-spark-preview",
    "gemini-3.1-pro": "gemini-3.1-pro",
    "claude-4.6-sonnet-thinking": "sonnet-4.6-thinking",
    "claude-4.6-opus-thinking": "opus-4.6-thinking",
    "claude-4.5-opus-thinking": "opus-4.5-thinking",
    "sonnet-4.6-thinking": "sonnet-4.6-thinking",
    "opus-4.6-thinking": "opus-4.6-thinking",
    "opus-4.5-thinking": "opus-4.5-thinking",
  },
} as const satisfies Record<keyof typeof MODEL_OPTIONS_BY_PROVIDER, Record<string, ModelSlug>>;

export const REASONING_EFFORT_OPTIONS_BY_PROVIDER = {
  codex: CODEX_REASONING_EFFORT_OPTIONS,
  cursor: [],
} as const satisfies Record<
  keyof typeof MODEL_OPTIONS_BY_PROVIDER,
  readonly CodexReasoningEffort[]
>;

export const DEFAULT_REASONING_EFFORT_BY_PROVIDER = {
  codex: "high",
  cursor: null,
} as const satisfies Record<keyof typeof MODEL_OPTIONS_BY_PROVIDER, CodexReasoningEffort | null>;
