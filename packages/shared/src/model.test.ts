import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_REASONING_EFFORT_BY_PROVIDER,
  MODEL_OPTIONS,
  MODEL_OPTIONS_BY_PROVIDER,
  REASONING_EFFORT_OPTIONS_BY_PROVIDER,
} from "@t3tools/contracts";

import {
  applyClaudePromptEffortPrefix,
  getEffectiveClaudeCodeEffort,
  getDefaultModel,
  getDefaultReasoningEffort,
  getModelOptions,
  getReasoningEffortOptions,
  inferProviderForModel,
  isClaudeUltrathinkPrompt,
  normalizeClaudeModelOptions,
  normalizeCodexModelOptions,
  normalizeModelSlug,
  resolveReasoningEffortForProvider,
  resolveModelSlug,
  resolveModelSlugForProvider,
  supportsClaudeAdaptiveReasoning,
  supportsClaudeFastMode,
  supportsClaudeMaxEffort,
  supportsClaudeThinkingToggle,
  supportsClaudeUltrathinkKeyword,
} from "./model";

describe("normalizeModelSlug", () => {
  it("maps known aliases to canonical slugs", () => {
    expect(normalizeModelSlug("5.3")).toBe("gpt-5.3-codex");
    expect(normalizeModelSlug("gpt-5.3")).toBe("gpt-5.3-codex");
  });

  it("returns null for empty or missing values", () => {
    expect(normalizeModelSlug("")).toBeNull();
    expect(normalizeModelSlug("   ")).toBeNull();
    expect(normalizeModelSlug(null)).toBeNull();
    expect(normalizeModelSlug(undefined)).toBeNull();
  });

  it("preserves non-aliased model slugs", () => {
    expect(normalizeModelSlug("gpt-5.2")).toBe("gpt-5.2");
    expect(normalizeModelSlug("gpt-5.2-codex")).toBe("gpt-5.2-codex");
  });

  it("does not leak prototype properties as aliases", () => {
    expect(normalizeModelSlug("toString")).toBe("toString");
    expect(normalizeModelSlug("constructor")).toBe("constructor");
  });

  it("uses provider-specific aliases", () => {
    expect(normalizeModelSlug("sonnet", "claudeAgent")).toBe("claude-sonnet-4-6");
    expect(normalizeModelSlug("opus-4.6", "claudeAgent")).toBe("claude-opus-4-6");
    expect(normalizeModelSlug("claude-haiku-4-5-20251001", "claudeAgent")).toBe("claude-haiku-4-5");
  });
});

describe("resolveModelSlug", () => {
  it("returns default only when the model is missing", () => {
    expect(resolveModelSlug(undefined)).toBe(DEFAULT_MODEL);
    expect(resolveModelSlug(null)).toBe(DEFAULT_MODEL);
  });

  it("preserves unknown custom models", () => {
    expect(resolveModelSlug("gpt-4.1")).toBe(DEFAULT_MODEL);
    expect(resolveModelSlug("custom/internal-model")).toBe(DEFAULT_MODEL);
  });

  it("resolves only supported model options", () => {
    for (const model of MODEL_OPTIONS) {
      expect(resolveModelSlug(model.slug)).toBe(model.slug);
    }
  });

  it("supports provider-aware resolution", () => {
    expect(resolveModelSlugForProvider("claudeAgent", undefined)).toBe(
      DEFAULT_MODEL_BY_PROVIDER.claudeAgent,
    );
    expect(resolveModelSlugForProvider("claudeAgent", "sonnet")).toBe("claude-sonnet-4-6");
    expect(resolveModelSlugForProvider("claudeAgent", "gpt-5.3-codex")).toBe(
      DEFAULT_MODEL_BY_PROVIDER.claudeAgent,
    );
  });

  it("keeps codex defaults for backward compatibility", () => {
    expect(getDefaultModel()).toBe(DEFAULT_MODEL);
    expect(getModelOptions()).toEqual(MODEL_OPTIONS);
    expect(getModelOptions("claudeAgent")).toEqual(MODEL_OPTIONS_BY_PROVIDER.claudeAgent);
  });
});

describe("getReasoningEffortOptions", () => {
  it("returns codex reasoning options for codex", () => {
    expect(getReasoningEffortOptions("codex")).toEqual(REASONING_EFFORT_OPTIONS_BY_PROVIDER.codex);
  });

  it("returns claude effort options for Opus 4.6", () => {
    expect(getReasoningEffortOptions("claudeAgent", "claude-opus-4-6")).toEqual([
      "low",
      "medium",
      "high",
      "max",
      "ultrathink",
    ]);
  });

  it("returns claude effort options for Sonnet 4.6", () => {
    expect(getReasoningEffortOptions("claudeAgent", "claude-sonnet-4-6")).toEqual([
      "low",
      "medium",
      "high",
      "ultrathink",
    ]);
  });

  it("returns no claude effort options for Haiku 4.5", () => {
    expect(getReasoningEffortOptions("claudeAgent", "claude-haiku-4-5")).toEqual([]);
  });
});

describe("inferProviderForModel", () => {
  it("detects known provider model slugs", () => {
    expect(inferProviderForModel("gpt-5.3-codex")).toBe("codex");
    expect(inferProviderForModel("claude-sonnet-4-6")).toBe("claudeAgent");
    expect(inferProviderForModel("sonnet")).toBe("claudeAgent");
  });

  it("falls back when the model is unknown", () => {
    expect(inferProviderForModel("custom/internal-model")).toBe("codex");
    expect(inferProviderForModel("custom/internal-model", "claudeAgent")).toBe("claudeAgent");
  });

  it("treats claude-prefixed custom slugs as claude", () => {
    expect(inferProviderForModel("claude-custom-internal")).toBe("claudeAgent");
  });
});

describe("getDefaultReasoningEffort", () => {
  it("returns provider-scoped defaults", () => {
    expect(getDefaultReasoningEffort("codex")).toBe(DEFAULT_REASONING_EFFORT_BY_PROVIDER.codex);
    expect(getDefaultReasoningEffort("claudeAgent")).toBe(
      DEFAULT_REASONING_EFFORT_BY_PROVIDER.claudeAgent,
    );
  });
});

describe("resolveReasoningEffortForProvider", () => {
  it("accepts provider-scoped effort values", () => {
    expect(resolveReasoningEffortForProvider("codex", "xhigh")).toBe("xhigh");
    expect(resolveReasoningEffortForProvider("claudeAgent", "ultrathink")).toBe("ultrathink");
  });

  it("rejects effort values from the wrong provider", () => {
    expect(resolveReasoningEffortForProvider("codex", "max")).toBeNull();
    expect(resolveReasoningEffortForProvider("claudeAgent", "xhigh")).toBeNull();
  });
});

describe("applyClaudePromptEffortPrefix", () => {
  it("prefixes ultrathink prompts exactly once", () => {
    expect(applyClaudePromptEffortPrefix("Investigate this", "ultrathink")).toBe(
      "Ultrathink:\nInvestigate this",
    );
    expect(applyClaudePromptEffortPrefix("Ultrathink:\nInvestigate this", "ultrathink")).toBe(
      "Ultrathink:\nInvestigate this",
    );
  });

  it("leaves non-ultrathink prompts unchanged", () => {
    expect(applyClaudePromptEffortPrefix("Investigate this", "high")).toBe("Investigate this");
  });
});

describe("getEffectiveClaudeCodeEffort", () => {
  it("does not persist ultrathink into Claude runtime configuration", () => {
    expect(getEffectiveClaudeCodeEffort("ultrathink")).toBeNull();
    expect(getEffectiveClaudeCodeEffort("high")).toBe("high");
  });

  it("returns null when no claude effort is selected", () => {
    expect(getEffectiveClaudeCodeEffort(null)).toBeNull();
    expect(getEffectiveClaudeCodeEffort(undefined)).toBeNull();
  });
});

describe("normalizeCodexModelOptions", () => {
  it("drops default-only codex options", () => {
    expect(
      normalizeCodexModelOptions({ reasoningEffort: "high", fastMode: false }),
    ).toBeUndefined();
  });

  it("preserves non-default codex options", () => {
    expect(normalizeCodexModelOptions({ reasoningEffort: "xhigh", fastMode: true })).toEqual({
      reasoningEffort: "xhigh",
      fastMode: true,
    });
  });
});

describe("normalizeClaudeModelOptions", () => {
  it("drops unsupported fast mode and max effort for Sonnet", () => {
    expect(
      normalizeClaudeModelOptions("claude-sonnet-4-6", {
        effort: "max",
        fastMode: true,
      }),
    ).toBeUndefined();
  });

  it("keeps the Haiku thinking toggle and removes unsupported effort", () => {
    expect(
      normalizeClaudeModelOptions("claude-haiku-4-5", {
        thinking: false,
        effort: "high",
      }),
    ).toEqual({
      thinking: false,
    });
  });
});

describe("supportsClaudeAdaptiveReasoning", () => {
  it("only enables adaptive reasoning for Opus 4.6 and Sonnet 4.6", () => {
    expect(supportsClaudeAdaptiveReasoning("claude-opus-4-6")).toBe(true);
    expect(supportsClaudeAdaptiveReasoning("claude-sonnet-4-6")).toBe(true);
    expect(supportsClaudeAdaptiveReasoning("claude-haiku-4-5")).toBe(false);
    expect(supportsClaudeAdaptiveReasoning(undefined)).toBe(false);
  });
});

describe("supportsClaudeMaxEffort", () => {
  it("only enables max effort for Opus 4.6", () => {
    expect(supportsClaudeMaxEffort("claude-opus-4-6")).toBe(true);
    expect(supportsClaudeMaxEffort("claude-sonnet-4-6")).toBe(false);
    expect(supportsClaudeMaxEffort("claude-haiku-4-5")).toBe(false);
    expect(supportsClaudeMaxEffort(undefined)).toBe(false);
  });
});

describe("supportsClaudeFastMode", () => {
  it("only enables Claude fast mode for Opus 4.6", () => {
    expect(supportsClaudeFastMode("claude-opus-4-6")).toBe(true);
    expect(supportsClaudeFastMode("opus")).toBe(true);
    expect(supportsClaudeFastMode("claude-sonnet-4-6")).toBe(false);
    expect(supportsClaudeFastMode("claude-haiku-4-5")).toBe(false);
    expect(supportsClaudeFastMode(undefined)).toBe(false);
  });
});

describe("supportsClaudeUltrathinkKeyword", () => {
  it("only enables ultrathink keyword handling for Opus 4.6 and Sonnet 4.6", () => {
    expect(supportsClaudeUltrathinkKeyword("claude-opus-4-6")).toBe(true);
    expect(supportsClaudeUltrathinkKeyword("claude-sonnet-4-6")).toBe(true);
    expect(supportsClaudeUltrathinkKeyword("claude-haiku-4-5")).toBe(false);
  });
});

describe("supportsClaudeThinkingToggle", () => {
  it("only enables the Claude thinking toggle for Haiku 4.5", () => {
    expect(supportsClaudeThinkingToggle("claude-opus-4-6")).toBe(false);
    expect(supportsClaudeThinkingToggle("claude-sonnet-4-6")).toBe(false);
    expect(supportsClaudeThinkingToggle("claude-haiku-4-5")).toBe(true);
    expect(supportsClaudeThinkingToggle("haiku")).toBe(true);
    expect(supportsClaudeThinkingToggle(undefined)).toBe(false);
  });
});

describe("isClaudeUltrathinkPrompt", () => {
  it("detects ultrathink prompts case-insensitively", () => {
    expect(isClaudeUltrathinkPrompt("Please ultrathink about this")).toBe(true);
    expect(isClaudeUltrathinkPrompt("Ultrathink:\nInvestigate")).toBe(true);
    expect(isClaudeUltrathinkPrompt("Think hard about this")).toBe(false);
    expect(isClaudeUltrathinkPrompt(undefined)).toBe(false);
  });
});
