import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_BY_PROVIDER, type ModelCapabilities } from "@t3tools/contracts";

import {
  applyClaudePromptEffortPrefix,
  buildProviderOptionSelectionsFromDescriptors,
  createModelCapabilities,
  createModelSelection,
  geminiCapabilitiesForModel,
  getGeminiThinkingConfigKind,
  getGeminiThinkingModelAlias,
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
  getProviderOptionBooleanSelectionValue,
  getProviderOptionDescriptors,
  getProviderOptionStringSelectionValue,
  isClaudeUltrathinkPrompt,
  normalizeModelSlug,
  resolveApiModelId,
  resolveModelSlugForProvider,
  resolveSelectableModel,
  trimOrNull,
} from "./model.ts";

const codexCaps: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "xhigh", label: "Extra High" },
        { id: "high", label: "High", isDefault: true },
      ],
      currentValue: "high",
    },
    {
      id: "fastMode",
      label: "Fast Mode",
      type: "boolean",
    },
  ],
});

const claudeCaps: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "effort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "medium", label: "Medium" },
        { id: "high", label: "High", isDefault: true },
        { id: "ultrathink", label: "Ultrathink" },
      ],
      currentValue: "high",
      promptInjectedValues: ["ultrathink"],
    },
    {
      id: "contextWindow",
      label: "Context Window",
      type: "select",
      options: [
        { id: "200k", label: "200k" },
        { id: "1m", label: "1M", isDefault: true },
      ],
      currentValue: "1m",
    },
  ],
});

describe("normalizeModelSlug", () => {
  it("maps known aliases to canonical slugs", () => {
    expect(normalizeModelSlug("gpt-5-codex")).toBe("gpt-5.4");
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

describe("resolveModelSlugForProvider", () => {
  it("returns defaults when the model is missing", () => {
    expect(resolveModelSlugForProvider("codex", undefined)).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
    expect(resolveModelSlugForProvider("claudeAgent", undefined)).toBe(
      DEFAULT_MODEL_BY_PROVIDER.claudeAgent,
    );
  });

  it("preserves normalized unknown models", () => {
    expect(resolveModelSlugForProvider("codex", "custom/internal-model")).toBe(
      "custom/internal-model",
    );
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

describe("misc helpers", () => {
  it("detects ultrathink prompts", () => {
    expect(isClaudeUltrathinkPrompt("Please ultrathink about this")).toBe(true);
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

describe("descriptor helpers", () => {
  it("applies selection values to capability descriptors", () => {
    expect(
      getProviderOptionDescriptors({
        caps: claudeCaps,
        selections: [
          { id: "effort", value: "medium" },
          { id: "contextWindow", value: "200k" },
        ],
      }),
    ).toEqual([
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "medium", label: "Medium" },
          { id: "high", label: "High", isDefault: true },
          { id: "ultrathink", label: "Ultrathink" },
        ],
        currentValue: "medium",
        promptInjectedValues: ["ultrathink"],
      },
      {
        id: "contextWindow",
        label: "Context Window",
        type: "select",
        options: [
          { id: "200k", label: "200k" },
          { id: "1m", label: "1M", isDefault: true },
        ],
        currentValue: "200k",
      },
    ]);
  });

  it("builds wire-format option selections from descriptors", () => {
    const descriptors = getProviderOptionDescriptors({
      caps: codexCaps,
      selections: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ],
    });

    expect(buildProviderOptionSelectionsFromDescriptors(descriptors)).toEqual([
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
    ]);
  });

  it("stores option selection arrays in model selections", () => {
    expect(
      createModelSelection("codex", "gpt-5.4", [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ]),
    ).toEqual({
      provider: "codex",
      model: "gpt-5.4",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ],
    });
  });

  it("reads typed option selection values", () => {
    const selection = createModelSelection("codex", "gpt-5.4", [
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
    ]);

    expect(getProviderOptionStringSelectionValue(selection.options, "reasoningEffort")).toBe(
      "high",
    );
    expect(getProviderOptionStringSelectionValue(selection.options, "fastMode")).toBeUndefined();
    expect(getProviderOptionBooleanSelectionValue(selection.options, "fastMode")).toBe(true);
    expect(
      getProviderOptionBooleanSelectionValue(selection.options, "reasoningEffort"),
    ).toBeUndefined();
    expect(getModelSelectionStringOptionValue(selection, "reasoningEffort")).toBe("high");
    expect(getModelSelectionBooleanOptionValue(selection, "fastMode")).toBe(true);
  });
});

describe("gemini helpers", () => {
  it("classifies Gemini families for thinking controls", () => {
    expect(getGeminiThinkingConfigKind("auto-gemini-3")).toBe("level");
    expect(getGeminiThinkingConfigKind("gemini-3.1-pro-preview")).toBe("level");
    expect(getGeminiThinkingConfigKind("auto-gemini-2.5")).toBe("budget");
    expect(getGeminiThinkingConfigKind("gemini-2.5-flash")).toBe("budget");
  });

  it("infers Gemini capabilities by family", () => {
    expect(geminiCapabilitiesForModel("gemini-3.1-pro-preview")).toEqual(
      createModelCapabilities({
        optionDescriptors: [
          {
            id: "thinking",
            label: "Thinking",
            type: "select",
            options: [
              { id: "HIGH", label: "High", isDefault: true },
              { id: "LOW", label: "Low" },
            ],
            currentValue: "HIGH",
          },
        ],
      }),
    );
    expect(geminiCapabilitiesForModel("gemini-2.5-flash")).toEqual(
      createModelCapabilities({
        optionDescriptors: [
          {
            id: "thinking",
            label: "Thinking",
            type: "select",
            options: [
              { id: "-1", label: "Dynamic", isDefault: true },
              { id: "512", label: "512 Tokens" },
            ],
            currentValue: "-1",
          },
        ],
      }),
    );
  });

  it("builds Gemini thinking aliases from generic selection arrays", () => {
    expect(getGeminiThinkingModelAlias("auto-gemini-3", [{ id: "thinking", value: "LOW" }])).toBe(
      "t3code-gemini-auto-gemini-3-thinking-level-low",
    );
    expect(getGeminiThinkingModelAlias("gemini-2.5-pro", [{ id: "thinking", value: "-1" }])).toBe(
      "t3code-gemini-gemini-2-5-pro-thinking-budget-dynamic",
    );
    expect(
      getGeminiThinkingModelAlias("gemini-2.5-flash", [{ id: "thinking", value: "0" }]),
    ).toBeNull();
  });
});

describe("resolveApiModelId", () => {
  it("appends [1m] suffix for Claude 1m context windows", () => {
    expect(
      resolveApiModelId(
        createModelSelection("claudeAgent", "claude-opus-4-6", [
          { id: "contextWindow", value: "1m" },
        ]),
      ),
    ).toBe("claude-opus-4-6[1m]");
  });

  it("maps Gemini thinking selections to generated aliases", () => {
    expect(
      resolveApiModelId(
        createModelSelection("gemini", "auto-gemini-3", [{ id: "thinking", value: "LOW" }]),
      ),
    ).toBe("t3code-gemini-auto-gemini-3-thinking-level-low");
  });

  it("returns the original model when Gemini selection is unsupported", () => {
    expect(
      resolveApiModelId(
        createModelSelection("gemini", "gemini-2.5-flash", [{ id: "thinking", value: "0" }]),
      ),
    ).toBe("gemini-2.5-flash");
  });
});
