import { Schema } from "effect";
import { ProviderKind } from "./orchestration";

export const CODEX_REASONING_EFFORT_OPTIONS = ["xhigh", "high", "medium", "low"] as const;
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORT_OPTIONS)[number];

export const CodexModelOptions = Schema.Struct({
  reasoningEffort: Schema.optional(Schema.Literals(CODEX_REASONING_EFFORT_OPTIONS)),
  fastMode: Schema.optional(Schema.Boolean),
});
export type CodexModelOptions = typeof CodexModelOptions.Type;

export const ProviderModelOptions = Schema.Struct({
  codex: Schema.optional(CodexModelOptions),
});
export type ProviderModelOptions = typeof ProviderModelOptions.Type;

type ModelOption = {
  readonly slug: string;
  readonly name: string;
};

export const MODEL_OPTIONS_BY_PROVIDER = {
  codex: [
    { slug: "gpt-5.4", name: "GPT-5.4" },
    { slug: "gpt-5.1-codex-max", name: "GPT-5.1 Codex Max" },
    { slug: "gpt-5.1-codex-mini", name: "GPT-5.1 Codex Mini" },
    { slug: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
    { slug: "gpt-5.3-codex-spark", name: "GPT-5.3 Codex Spark" },
    { slug: "gpt-5.2-codex", name: "GPT-5.2 Codex" },
    { slug: "gpt-5.2", name: "GPT-5.2" },
  ],
} as const satisfies Record<ProviderKind, readonly ModelOption[]>;
export type ModelOptionsByProvider = typeof MODEL_OPTIONS_BY_PROVIDER;

type BuiltInModelSlug = ModelOptionsByProvider[ProviderKind][number]["slug"];
export type ModelSlug = BuiltInModelSlug | (string & {});

export const DEFAULT_MODEL_BY_PROVIDER = {
  codex: "gpt-5.4",
} as const satisfies Record<ProviderKind, ModelSlug>;

export const MODEL_SLUG_ALIASES_BY_PROVIDER = {
  codex: {
    "5.4": "gpt-5.4",
    "5.3": "gpt-5.3-codex",
    "gpt-5.3": "gpt-5.3-codex",
    "5.3-spark": "gpt-5.3-codex-spark",
    "gpt-5.3-spark": "gpt-5.3-codex-spark",
    "5.1-mini": "gpt-5.1-codex-mini",
    "gpt-5.1-mini": "gpt-5.1-codex-mini",
    "5.1-max": "gpt-5.1-codex-max",
    "gpt-5.1-max": "gpt-5.1-codex-max",
  },
} as const satisfies Record<ProviderKind, Record<string, ModelSlug>>;

export const REASONING_EFFORT_OPTIONS_BY_PROVIDER = {
  codex: CODEX_REASONING_EFFORT_OPTIONS,
} as const satisfies Record<ProviderKind, readonly CodexReasoningEffort[]>;

export const DEFAULT_REASONING_EFFORT_BY_PROVIDER = {
  codex: "high",
} as const satisfies Record<ProviderKind, CodexReasoningEffort | null>;
