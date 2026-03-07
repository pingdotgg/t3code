import { Schema } from "effect";
import { ProviderKind } from "./orchestration";

export const CODEX_REASONING_EFFORT_OPTIONS = ["xhigh", "high", "medium", "low"] as const;
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORT_OPTIONS)[number];

export const CodexModelOptions = Schema.Struct({
  reasoningEffort: Schema.optional(Schema.Literals(CODEX_REASONING_EFFORT_OPTIONS)),
  fastMode: Schema.optional(Schema.Boolean),
});
export type CodexModelOptions = typeof CodexModelOptions.Type;
export const CopilotModelOptions = Schema.Struct({
  reasoningEffort: Schema.optional(Schema.Literals(CODEX_REASONING_EFFORT_OPTIONS)),
});
export type CopilotModelOptions = typeof CopilotModelOptions.Type;

export const ProviderModelOptions = Schema.Struct({
  codex: Schema.optional(CodexModelOptions),
  copilot: Schema.optional(CopilotModelOptions),
});
export type ProviderModelOptions = typeof ProviderModelOptions.Type;

type ModelOption = {
  readonly slug: string;
  readonly name: string;
};

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
} as const satisfies Record<ProviderKind, readonly ModelOption[]>;
export type ModelOptionsByProvider = typeof MODEL_OPTIONS_BY_PROVIDER;

type BuiltInModelSlug = ModelOptionsByProvider[ProviderKind][number]["slug"];
export type ModelSlug = BuiltInModelSlug | (string & {});

export const DEFAULT_MODEL_BY_PROVIDER = {
  codex: "gpt-5.4",
  copilot: "claude-sonnet-4.6",
} as const satisfies Record<ProviderKind, ModelSlug>;

export const MODEL_SLUG_ALIASES_BY_PROVIDER = {
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
} as const satisfies Record<ProviderKind, Record<string, ModelSlug>>;

export const REASONING_EFFORT_OPTIONS_BY_PROVIDER = {
  codex: CODEX_REASONING_EFFORT_OPTIONS,
  copilot: [],
} as const satisfies Record<ProviderKind, readonly CodexReasoningEffort[]>;

export const DEFAULT_REASONING_EFFORT_BY_PROVIDER = {
  codex: "high",
  copilot: null,
} as const satisfies Record<ProviderKind, CodexReasoningEffort | null>;
