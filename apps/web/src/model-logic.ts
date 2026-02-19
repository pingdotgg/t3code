export {
  CLAUDE_MODEL_OPTIONS,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_MODEL,
  MODEL_OPTIONS,
  resolveClaudeModelSlug,
  normalizeModelSlug,
  resolveModelSlug,
} from "@t3tools/contracts";
import {
  CLAUDE_MODEL_OPTIONS,
  DEFAULT_MODEL,
  DEFAULT_CLAUDE_MODEL,
  MODEL_OPTIONS,
  resolveClaudeModelSlug,
  resolveModelSlug,
  type ProviderKind,
  type ProviderModelOption,
} from "@t3tools/contracts";

export type SupportedModelSlug = string;

export function modelOptionsForProvider(
  provider: ProviderKind,
  availableModels?: ProviderModelOption[],
): ReadonlyArray<ProviderModelOption> {
  if (provider === "claudeCode" && Array.isArray(availableModels) && availableModels.length > 0) {
    return availableModels;
  }

  return provider === "claudeCode" ? CLAUDE_MODEL_OPTIONS : MODEL_OPTIONS;
}

export function resolveModelSlugForProvider(
  provider: ProviderKind,
  model: string | null | undefined,
): SupportedModelSlug {
  return provider === "claudeCode" ? resolveClaudeModelSlug(model) : resolveModelSlug(model);
}

export function defaultModelForProvider(provider: ProviderKind): SupportedModelSlug {
  return provider === "claudeCode" ? DEFAULT_CLAUDE_MODEL : DEFAULT_MODEL;
}

export const REASONING_OPTIONS = ["xhigh", "high", "medium", "low"] as const;
export type ReasoningEffort = (typeof REASONING_OPTIONS)[number];
export const DEFAULT_REASONING: ReasoningEffort = "high";
