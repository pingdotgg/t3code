import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas";
import type { ProviderKind } from "./orchestration";

export const CODEX_REASONING_EFFORT_OPTIONS = ["xhigh", "high", "medium", "low"] as const;
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORT_OPTIONS)[number];
export const CLAUDE_CODE_EFFORT_OPTIONS = ["low", "medium", "high", "max", "ultrathink"] as const;
export type ClaudeCodeEffort = (typeof CLAUDE_CODE_EFFORT_OPTIONS)[number];
export type ProviderReasoningEffort = CodexReasoningEffort | ClaudeCodeEffort;

export const CodexModelOptions = Schema.Struct({
  reasoningEffort: Schema.optional(Schema.Literals(CODEX_REASONING_EFFORT_OPTIONS)),
  fastMode: Schema.optional(Schema.Boolean),
});
export type CodexModelOptions = typeof CodexModelOptions.Type;

export const ClaudeModelOptions = Schema.Struct({
  thinking: Schema.optional(Schema.Boolean),
  effort: Schema.optional(Schema.Literals(CLAUDE_CODE_EFFORT_OPTIONS)),
  fastMode: Schema.optional(Schema.Boolean),
  /** API suffix for context window selection (e.g. `"[1m]"`). Omit for default. */
  contextWindow: Schema.optional(Schema.String),
});
export type ClaudeModelOptions = typeof ClaudeModelOptions.Type;

export const ProviderModelOptions = Schema.Struct({
  codex: Schema.optional(CodexModelOptions),
  claudeAgent: Schema.optional(ClaudeModelOptions),
});
export type ProviderModelOptions = typeof ProviderModelOptions.Type;

export const EffortOption = Schema.Struct({
  value: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  isDefault: Schema.optional(Schema.Boolean),
});
export type EffortOption = typeof EffortOption.Type;

export const ContextWindowOption = Schema.Struct({
  /** API suffix appended to the model slug (e.g. `""` for default, `"[1m]"` for 1M). */
  value: Schema.String,
  label: TrimmedNonEmptyString,
  isDefault: Schema.optional(Schema.Boolean),
});
export type ContextWindowOption = typeof ContextWindowOption.Type;

export const ModelCapabilities = Schema.Struct({
  reasoningEffortLevels: Schema.Array(EffortOption),
  supportsFastMode: Schema.Boolean,
  supportsThinkingToggle: Schema.Boolean,
  contextWindowOptions: Schema.Array(ContextWindowOption),
  promptInjectedEffortLevels: Schema.Array(TrimmedNonEmptyString),
});
export type ModelCapabilities = typeof ModelCapabilities.Type;

type ModelDefinition = {
  readonly slug: string;
  readonly name: string;
  readonly capabilities: ModelCapabilities;
};

/**
 * TODO: This should not be a static array, each provider
 * should return its own model list over the WS API.
 */
export const MODEL_OPTIONS_BY_PROVIDER = {
  codex: [
    {
      slug: "gpt-5.4",
      name: "GPT-5.4",
      capabilities: {
        reasoningEffortLevels: [
          { value: "xhigh", label: "Extra High" },
          { value: "high", label: "High", isDefault: true },
          { value: "medium", label: "Medium" },
          { value: "low", label: "Low" },
        ],
        supportsFastMode: true,
        supportsThinkingToggle: false,
        contextWindowOptions: [],
        promptInjectedEffortLevels: [],
      },
    },
    {
      slug: "gpt-5.4-mini",
      name: "GPT-5.4 Mini",
      capabilities: {
        reasoningEffortLevels: [
          { value: "xhigh", label: "Extra High" },
          { value: "high", label: "High", isDefault: true },
          { value: "medium", label: "Medium" },
          { value: "low", label: "Low" },
        ],
        supportsFastMode: true,
        supportsThinkingToggle: false,
        contextWindowOptions: [],
        promptInjectedEffortLevels: [],
      },
    },
    {
      slug: "gpt-5.3-codex",
      name: "GPT-5.3 Codex",
      capabilities: {
        reasoningEffortLevels: [
          { value: "xhigh", label: "Extra High" },
          { value: "high", label: "High", isDefault: true },
          { value: "medium", label: "Medium" },
          { value: "low", label: "Low" },
        ],
        supportsFastMode: true,
        supportsThinkingToggle: false,
        contextWindowOptions: [],
        promptInjectedEffortLevels: [],
      },
    },
    {
      slug: "gpt-5.3-codex-spark",
      name: "GPT-5.3 Codex Spark",
      capabilities: {
        reasoningEffortLevels: [
          { value: "xhigh", label: "Extra High" },
          { value: "high", label: "High", isDefault: true },
          { value: "medium", label: "Medium" },
          { value: "low", label: "Low" },
        ],
        supportsFastMode: true,
        supportsThinkingToggle: false,
        contextWindowOptions: [],
        promptInjectedEffortLevels: [],
      },
    },
    {
      slug: "gpt-5.2-codex",
      name: "GPT-5.2 Codex",
      capabilities: {
        reasoningEffortLevels: [
          { value: "xhigh", label: "Extra High" },
          { value: "high", label: "High", isDefault: true },
          { value: "medium", label: "Medium" },
          { value: "low", label: "Low" },
        ],
        supportsFastMode: true,
        supportsThinkingToggle: false,
        contextWindowOptions: [],
        promptInjectedEffortLevels: [],
      },
    },
    {
      slug: "gpt-5.2",
      name: "GPT-5.2",
      capabilities: {
        reasoningEffortLevels: [
          { value: "xhigh", label: "Extra High" },
          { value: "high", label: "High", isDefault: true },
          { value: "medium", label: "Medium" },
          { value: "low", label: "Low" },
        ],
        supportsFastMode: true,
        supportsThinkingToggle: false,
        contextWindowOptions: [],
        promptInjectedEffortLevels: [],
      },
    },
  ],
  claudeAgent: [
    {
      slug: "claude-opus-4-6",
      name: "Claude Opus 4.6",
      capabilities: {
        reasoningEffortLevels: [
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High", isDefault: true },
          { value: "max", label: "Max" },
          { value: "ultrathink", label: "Ultrathink" },
        ],
        supportsFastMode: true,
        supportsThinkingToggle: false,
        contextWindowOptions: [
          { value: "", label: "200k", isDefault: true },
          { value: "[1m]", label: "1M" },
        ],
        promptInjectedEffortLevels: ["ultrathink"],
      },
    },
    {
      slug: "claude-sonnet-4-6",
      name: "Claude Sonnet 4.6",
      capabilities: {
        reasoningEffortLevels: [
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High", isDefault: true },
          { value: "ultrathink", label: "Ultrathink" },
        ],
        supportsFastMode: false,
        supportsThinkingToggle: false,
        contextWindowOptions: [
          { value: "", label: "200k", isDefault: true },
          { value: "[1m]", label: "1M" },
        ],
        promptInjectedEffortLevels: ["ultrathink"],
      },
    },
    {
      slug: "claude-haiku-4-5",
      name: "Claude Haiku 4.5",
      capabilities: {
        reasoningEffortLevels: [],
        supportsFastMode: false,
        supportsThinkingToggle: true,
        contextWindowOptions: [],
        promptInjectedEffortLevels: [],
      },
    },
  ],
} as const satisfies Record<ProviderKind, readonly ModelDefinition[]>;
export type ModelOptionsByProvider = typeof MODEL_OPTIONS_BY_PROVIDER;

type BuiltInModelSlug = (typeof MODEL_OPTIONS_BY_PROVIDER)[ProviderKind][number]["slug"];
export type ModelSlug = BuiltInModelSlug | (string & {});

export const DEFAULT_MODEL_BY_PROVIDER: Record<ProviderKind, ModelSlug> = {
  codex: "gpt-5.4",
  claudeAgent: "claude-sonnet-4-6",
};

export const DEFAULT_MODEL = DEFAULT_MODEL_BY_PROVIDER.codex;

/** Per-provider text generation model defaults. */
export const DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER: Record<ProviderKind, string> = {
  codex: "gpt-5.4-mini",
  claudeAgent: "claude-haiku-4-5",
};

export const MODEL_SLUG_ALIASES_BY_PROVIDER: Record<ProviderKind, Record<string, ModelSlug>> = {
  codex: {
    "5.4": "gpt-5.4",
    "5.3": "gpt-5.3-codex",
    "gpt-5.3": "gpt-5.3-codex",
    "5.3-spark": "gpt-5.3-codex-spark",
    "gpt-5.3-spark": "gpt-5.3-codex-spark",
  },
  claudeAgent: {
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
};

// ── Provider display names ────────────────────────────────────────────

export const PROVIDER_DISPLAY_NAMES: Record<ProviderKind, string> = {
  codex: "Codex",
  claudeAgent: "Claude",
};
