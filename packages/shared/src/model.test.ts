import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  type ModelCapabilities,
} from "@t3tools/contracts";

import {
  applyClaudePromptEffortPrefix,
  getDefaultContextWindow,
  getDefaultEffort,
  getModelCapabilities,
  hasContextWindowOption,
  hasEffortLevel,
  isClaudeUltrathinkPrompt,
  normalizeClaudeModelOptions,
  normalizeModelSlug,
  resolveClaudeApiModelId,
  resolveModelSlug,
  resolveModelSlugForProvider,
  resolveSelectableModel,
  trimOrNull,
} from "./model";

const codexCaps: ModelCapabilities = {
  reasoningEffortLevels: [
    { value: "xhigh", label: "Extra High" },
    { value: "high", label: "High", isDefault: true },
  ],
  supportsFastMode: true,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

const claudeCaps: ModelCapabilities = {
  reasoningEffortLevels: [
    { value: "medium", label: "Medium" },
    { value: "high", label: "High", isDefault: true },
    { value: "ultrathink", label: "Ultrathink" },
  ],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: ["ultrathink"],
};

describe("normalizeModelSlug", () => {
  it("maps known aliases to canonical slugs", () => {
    expect(normalizeModelSlug("5.3")).toBe("gpt-5.3-codex");
    expect(normalizeModelSlug("sonnet", "claudeAgent")).toBe("claude-sonnet-4-6");
  });

  it("returns null for empty or missing values", () => {
    expect(normalizeModelSlug("")).toBeNull();
    expect(normalizeModelSlug("   ")).toBeNull();
    expect(normalizeModelSlug(null)).toBeNull();
    expect(normalizeModelSlug(undefined)).toBeNull();
  });
});

describe("resolveModelSlug", () => {
  it("returns defaults when the model is missing", () => {
    expect(resolveModelSlug(undefined)).toBe(DEFAULT_MODEL);
    expect(resolveModelSlugForProvider("claudeAgent", undefined)).toBe(
      DEFAULT_MODEL_BY_PROVIDER.claudeAgent,
    );
  });

  it("preserves normalized unknown models", () => {
    expect(resolveModelSlug("custom/internal-model")).toBe("custom/internal-model");
  });
});

describe("resolveSelectableModel", () => {
  it("resolves exact slugs, labels, and aliases", () => {
    const options = [
      { slug: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
      { slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    ];
    expect(resolveSelectableModel("codex", "gpt-5.3-codex", options)).toBe("gpt-5.3-codex");
    expect(resolveSelectableModel("codex", "gpt-5.3 codex", options)).toBe("gpt-5.3-codex");
    expect(resolveSelectableModel("claudeAgent", "sonnet", options)).toBe("claude-sonnet-4-6");
  });
});

describe("capability helpers", () => {
  it("reads default efforts", () => {
    expect(getDefaultEffort(codexCaps)).toBe("high");
    expect(getDefaultEffort(claudeCaps)).toBe("high");
  });

  it("checks effort support", () => {
    expect(hasEffortLevel(codexCaps, "xhigh")).toBe(true);
    expect(hasEffortLevel(codexCaps, "max")).toBe(false);
  });
});

describe("misc helpers", () => {
  it("detects ultrathink prompts", () => {
    expect(isClaudeUltrathinkPrompt("Ultrathink:\nInvestigate")).toBe(true);
    expect(isClaudeUltrathinkPrompt("Investigate")).toBe(false);
  });

  it("prefixes ultrathink prompts once", () => {
    expect(applyClaudePromptEffortPrefix("Investigate", "ultrathink")).toBe(
      "Ultrathink:\nInvestigate",
    );
    expect(applyClaudePromptEffortPrefix("Ultrathink:\nInvestigate", "ultrathink")).toBe(
      "Ultrathink:\nInvestigate",
    );
  });

  it("trims strings to null", () => {
    expect(trimOrNull("  hi  ")).toBe("hi");
    expect(trimOrNull("   ")).toBeNull();
  });
});

describe("contextWindowOptions capability", () => {
  it("offers context window options for Opus 4.6 and Sonnet 4.6", () => {
    const opusOpts = getModelCapabilities("claudeAgent", "claude-opus-4-6").contextWindowOptions;
    expect(opusOpts.length).toBeGreaterThan(1);
    expect(opusOpts.find((o) => o.isDefault)?.value).toBe("");
    expect(
      hasContextWindowOption(getModelCapabilities("claudeAgent", "claude-opus-4-6"), "[1m]"),
    ).toBe(true);

    const sonnetOpts = getModelCapabilities(
      "claudeAgent",
      "claude-sonnet-4-6",
    ).contextWindowOptions;
    expect(sonnetOpts.length).toBeGreaterThan(1);
    expect(
      hasContextWindowOption(getModelCapabilities("claudeAgent", "claude-sonnet-4-6"), "[1m]"),
    ).toBe(true);
  });

  it("has no context window options for Haiku 4.5, unknown models, and Codex", () => {
    expect(getModelCapabilities("claudeAgent", "claude-haiku-4-5").contextWindowOptions).toEqual(
      [],
    );
    expect(getModelCapabilities("claudeAgent", undefined).contextWindowOptions).toEqual([]);
    expect(getModelCapabilities("codex", "gpt-5.4").contextWindowOptions).toEqual([]);
  });
});

describe("getDefaultContextWindow", () => {
  it("returns empty string (default suffix) for models with context window options", () => {
    expect(getDefaultContextWindow(getModelCapabilities("claudeAgent", "claude-opus-4-6"))).toBe(
      "",
    );
  });

  it("returns empty string for models without context window options", () => {
    expect(getDefaultContextWindow(getModelCapabilities("claudeAgent", "claude-haiku-4-5"))).toBe(
      "",
    );
  });
});

describe("resolveClaudeApiModelId", () => {
  it("appends context window suffix when set on a supported model", () => {
    expect(resolveClaudeApiModelId("claude-opus-4-6", { contextWindow: "[1m]" })).toBe(
      "claude-opus-4-6[1m]",
    );
    expect(resolveClaudeApiModelId("claude-sonnet-4-6", { contextWindow: "[1m]" })).toBe(
      "claude-sonnet-4-6[1m]",
    );
  });

  it("returns the model as-is when contextWindow is not set", () => {
    expect(resolveClaudeApiModelId("claude-opus-4-6", {})).toBe("claude-opus-4-6");
    expect(resolveClaudeApiModelId("claude-opus-4-6", null)).toBe("claude-opus-4-6");
    expect(resolveClaudeApiModelId("claude-opus-4-6", undefined)).toBe("claude-opus-4-6");
  });

  it("returns the model as-is for the default context window value", () => {
    expect(resolveClaudeApiModelId("claude-opus-4-6", { contextWindow: "" })).toBe(
      "claude-opus-4-6",
    );
  });

  it("ignores unsupported context window values", () => {
    expect(resolveClaudeApiModelId("claude-haiku-4-5", { contextWindow: "[1m]" })).toBe(
      "claude-haiku-4-5",
    );
    expect(resolveClaudeApiModelId("claude-opus-4-6", { contextWindow: "[bogus]" })).toBe(
      "claude-opus-4-6",
    );
  });
});

describe("normalizeClaudeModelOptions with contextWindow", () => {
  it("preserves non-default contextWindow for supported models", () => {
    expect(normalizeClaudeModelOptions("claude-opus-4-6", { contextWindow: "[1m]" })).toEqual({
      contextWindow: "[1m]",
    });
  });

  it("strips contextWindow for unsupported models", () => {
    expect(
      normalizeClaudeModelOptions("claude-haiku-4-5", { contextWindow: "[1m]" }),
    ).toBeUndefined();
  });

  it("strips contextWindow when it is the default value", () => {
    expect(normalizeClaudeModelOptions("claude-opus-4-6", { contextWindow: "" })).toBeUndefined();
  });

  it("strips unknown contextWindow values", () => {
    expect(
      normalizeClaudeModelOptions("claude-opus-4-6", { contextWindow: "[bogus]" }),
    ).toBeUndefined();
  });
});
