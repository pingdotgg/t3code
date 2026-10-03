import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ModelCapabilities } from "@t3tools/contracts";

import {
  applyClaudePromptEffortPrefix,
  buildExplicitProviderOptionSelectionsFromDescriptors,
  buildProviderOptionSelectionsFromDescriptors,
  createModelCapabilities,
  createModelSelection,
  formatCodexModelName,
  formatModelSlugName,
  getProviderOptionCurrentLabel,
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
  getProviderOptionDescriptors,
  readCustomModelEntries,
  resolveModelProviderLabel,
  toCustomModelSetting,
  getProviderOptionBooleanSelectionValue,
  getProviderOptionStringSelectionValue,
  normalizeCustomModelSlug,
  normalizeModelSlug,
  modelProviderId,
  modelSelectionsEqual,
} from "./model.ts";

it("keeps the Codex catalog display formatting", () => {
  expect(formatCodexModelName("gpt-5.3-codex-spark")).toBe("GPT-5.3-Codex-Spark");
  expect(formatCodexModelName("GPT Test")).toBe("GPT Test");
});

it.each([
  ["gpt-5.4", "GPT-5.4"],
  ["claude-opus-4-6", "Claude Opus 4.6"],
  ["claude-sonnet-4-20250514", "Claude Sonnet 4 20250514"],
  ["claude-opus-4-6[1m]", "Claude Opus 4.6[1m]"],
  ["openai/gpt-5.4-mini", "openai/GPT-5.4-Mini"],
  ["gemini-2.5-pro-preview-06-05", "Gemini 2.5 Pro Preview 06 05"],
  ["custom/model-v2", "custom/model-v2"],
  ["gpt-proxy", "gpt-proxy"],
  ["My Custom Model", "My Custom Model"],
])("formats a known model ID without losing its qualifiers: %s", (slug, expected) => {
  expect(formatModelSlugName(slug)).toBe(expected);
});

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

describe("model slug normalization", () => {
  it("preserves exact custom slugs instead of expanding provider aliases", () => {
    // Claude aliases now resolve through the model catalog (#9084), so the
    // provider alias table passes unknown slugs through unchanged.
    const claude = ProviderDriverKind.make("claudeAgent");

    expect(normalizeModelSlug("opus", claude)).toBe("opus");
    expect(normalizeCustomModelSlug(" opus ")).toBe("opus");
  });
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

  it("builds dispatch options only from explicit selections", () => {
    const descriptors = getProviderOptionDescriptors({
      caps: codexCaps,
      selections: [{ id: "fastMode", value: true }],
    });

    expect(buildExplicitProviderOptionSelectionsFromDescriptors(descriptors, undefined)).toBe(
      undefined,
    );
    expect(
      buildExplicitProviderOptionSelectionsFromDescriptors(descriptors, [
        { id: "fastMode", value: true },
      ]),
    ).toEqual([{ id: "fastMode", value: true }]);
  });

  it("stores option selection arrays in model selections", () => {
    expect(
      createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ]),
    ).toEqual({
      instanceId: "codex",
      model: "gpt-5.4",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ],
    });
  });

  it("reads typed option selection values", () => {
    const selection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
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

  it("compares complete model selections independent of option ordering", () => {
    const left = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
    ]);
    const reordered = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
      { id: "fastMode", value: true },
      { id: "reasoningEffort", value: "high" },
    ]);

    expect(modelSelectionsEqual(left, reordered)).toBe(true);
    expect(
      modelSelectionsEqual(left, {
        ...reordered,
        options: [
          { id: "fastMode", value: true },
          { id: "reasoningEffort", value: "medium" },
        ],
      }),
    ).toBe(false);
    expect(modelSelectionsEqual(left, { ...reordered, model: "gpt-5.5" })).toBe(false);
  });
});

describe("applyClaudePromptEffortPrefix", () => {
  it("keeps slash commands intact when ultrathink is selected", () => {
    expect(applyClaudePromptEffortPrefix("/compact", "ultrathink")).toBe("/compact");
    expect(applyClaudePromptEffortPrefix(" /compact keep recent errors ", "ultrathink")).toBe(
      "/compact keep recent errors",
    );
    expect(applyClaudePromptEffortPrefix(" /review src/model.ts ", "ultrathink")).toBe(
      "/review src/model.ts",
    );
    expect(applyClaudePromptEffortPrefix("/security-review", "ultrathink")).toBe(
      "/security-review",
    );
    expect(applyClaudePromptEffortPrefix("/plugin:skill run", "ultrathink")).toBe(
      "/plugin:skill run",
    );
    expect(applyClaudePromptEffortPrefix("/deploy.prod to staging", "ultrathink")).toBe(
      "/deploy.prod to staging",
    );
  });

  it("still adds the ultrathink prefix to ordinary prompts", () => {
    expect(applyClaudePromptEffortPrefix("Investigate this failure", "ultrathink")).toBe(
      "Ultrathink:\nInvestigate this failure",
    );
    expect(applyClaudePromptEffortPrefix("/home/theo/app.ts crashed on load", "ultrathink")).toBe(
      "Ultrathink:\n/home/theo/app.ts crashed on load",
    );
  });
});

describe("readCustomModelEntries", () => {
  const capabilities: ModelCapabilities = {
    optionDescriptors: [
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [{ id: "high", label: "High", isDefault: true }],
        currentValue: "high",
      },
    ],
  };

  it("resolves bare slugs and entries, trimming and deduplicating on slug", () => {
    expect(
      readCustomModelEntries([
        " bare ",
        { slug: "named", name: " Named ", capabilities },
        "bare",
        { slug: "named", name: "Second" },
        "",
        { name: "no slug" },
        42,
      ]),
    ).toEqual([
      { slug: "bare", name: "bare", capabilities: null },
      { slug: "named", name: "Named", capabilities },
    ]);
  });

  it("drops unparseable capabilities but keeps the entry", () => {
    expect(
      readCustomModelEntries([{ slug: "x", capabilities: { optionDescriptors: "nope" } }]),
    ).toEqual([{ slug: "x", name: "x", capabilities: null }]);
    expect(readCustomModelEntries("not a list")).toEqual([]);
  });

  it("writes the compact stored shape back", () => {
    expect(toCustomModelSetting({ slug: "x", name: "x", capabilities: null })).toBe("x");
    expect(
      toCustomModelSetting({ slug: "x", name: "x", capabilities: { optionDescriptors: [] } }),
    ).toBe("x");
    expect(toCustomModelSetting({ slug: "x", name: "X", capabilities })).toEqual({
      slug: "x",
      name: "X",
      capabilities,
    });
  });
});

describe("provider-reported option display", () => {
  const selection = createModelSelection(ProviderInstanceId.make("opencode"), "ling");
  const reported = { ...selection, options: [{ id: "variant", value: "default" }] };
  const descriptor = {
    id: "variant",
    label: "Reasoning",
    type: "select" as const,
    options: [
      { id: "none", label: "None" },
      { id: "thinking", label: "Thinking" },
    ],
  };

  it("shows explicit reports without adding a choice or a dispatch option", () => {
    expect(getProviderOptionCurrentLabel(descriptor, selection, reported)).toBe("Default");
    expect(
      getProviderOptionCurrentLabel(descriptor, selection, {
        ...reported,
        options: [{ id: "variant", value: "thinking" }],
      }),
    ).toBe("Thinking");
    expect(
      getProviderOptionCurrentLabel(
        { ...descriptor, currentValue: "none" },
        { ...selection, options: [{ id: "variant", value: "none" }] },
        reported,
      ),
    ).toBe("None");
    expect(descriptor.options.map((option) => option.id)).toEqual(["none", "thinking"]);
    expect(buildProviderOptionSelectionsFromDescriptors([descriptor])).toBeUndefined();
    expect(getProviderOptionCurrentLabel(descriptor, selection)).toBe("Unknown");
    const effortDescriptor = { ...descriptor, id: "effort", currentValue: "default" };
    expect(getProviderOptionCurrentLabel(effortDescriptor, selection)).toBeUndefined();
    expect(
      getProviderOptionCurrentLabel(effortDescriptor, selection, {
        ...reported,
        model: "other",
        options: [{ id: "effort", value: "default" }],
      }),
    ).toBeUndefined();
    expect(
      getProviderOptionCurrentLabel(effortDescriptor, selection, {
        ...reported,
        options: [{ id: "effort", value: "default" }],
      }),
    ).toBe("Default");
    expect(
      getProviderOptionCurrentLabel({ ...descriptor, currentValue: "thinking" }, selection),
    ).toBe("Unknown");
  });

  it.each([
    { ...selection, model: "other" },
    { ...selection, instanceId: ProviderInstanceId.make("other") },
    { ...selection, options: [{ id: "variant", value: "none" }] },
  ])("ignores reports after changing the model, instance, or option: %j", (selected) => {
    expect(getProviderOptionCurrentLabel(descriptor, selected, reported)).toBe("Unknown");
  });
});

describe("model provider identity", () => {
  it("reads the upstream provider segment from a slash-qualified slug", () => {
    expect(modelProviderId("deepseek/deepseek-flash")).toBe("deepseek");
    expect(modelProviderId("opencode-go/deepseek-v4.1-flash")).toBe("opencode-go");
    expect(modelProviderId("gpt-5.6-sol")).toBeUndefined();
    expect(modelProviderId("/leading")).toBeUndefined();
    expect(modelProviderId("trailing/")).toBe("trailing");
  });

  it("labels the same OpenCode model by its upstream provider so duplicates stay distinct", () => {
    const official = resolveModelProviderLabel({
      slug: "deepseek/deepseek-flash",
      driverKind: ProviderDriverKind.make("opencode"),
    });
    const go = resolveModelProviderLabel({
      slug: "opencode-go/deepseek-v4.1-flash",
      driverKind: ProviderDriverKind.make("opencode"),
    });
    expect(official).not.toBe(go);
    expect(official).toBe("DeepSeek");
    expect(go).toBe("OpenCode Go");
  });

  it("uses the product casing for known OpenCode upstreams", () => {
    const label = (slug: string) =>
      resolveModelProviderLabel({ slug, driverKind: ProviderDriverKind.make("opencode") });
    expect(label("deepseek/deepseek-flash")).toBe("DeepSeek");
    expect(label("opencode/claude-fable-5")).toBe("OpenCode Zen");
    expect(label("opencode-go/deepseek-v4.1-flash")).toBe("OpenCode Go");
    expect(label("openai/gpt-5.4")).toBe("OpenAI");
    expect(label("openrouter/deepseek-flash")).toBe("OpenRouter");
    expect(label("github-copilot/claude-fable-5")).toBe("GitHub Copilot");
  });

  it("does not decode slash-qualified slugs for other drivers", () => {
    expect(
      resolveModelProviderLabel({
        slug: "meta-llama/Llama-3",
        driverKind: ProviderDriverKind.make("codex"),
      }),
    ).toBeUndefined();
    expect(resolveModelProviderLabel({ slug: "deepseek/deepseek-flash" })).toBeUndefined();
  });

  it("prefers a catalog-reported custom upstream name over the slug", () => {
    expect(
      resolveModelProviderLabel({
        slug: "github-copilot/claude-fable-5",
        subProvider: "GitHub Copilot",
        driverKind: ProviderDriverKind.make("opencode"),
      }),
    ).toBe("GitHub Copilot");
    expect(resolveModelProviderLabel({ slug: "gpt-5.6-sol", subProvider: "OpenAI" })).toBe(
      "OpenAI",
    );
  });

  it("leaves plain built-in models unlabeled", () => {
    expect(
      resolveModelProviderLabel({
        slug: "gpt-5.6-sol",
        driverKind: ProviderDriverKind.make("codex"),
      }),
    ).toBeUndefined();
    expect(
      resolveModelProviderLabel({ slug: "claude-sonnet-5", subProvider: "  " }),
    ).toBeUndefined();
  });

  it("humanizes separator- and camel-case provider IDs", () => {
    const label = (slug: string) =>
      resolveModelProviderLabel({ slug, driverKind: ProviderDriverKind.make("opencode") });
    expect(label("some-upstream/deepseek-flash")).toBe("Some Upstream");
    expect(label("github_copilot/x")).toBe("GitHub Copilot");
    expect(label("openCode/x")).toBe("Open Code");
  });

  it("treats Object prototype member names as ordinary custom providers", () => {
    const label = (slug: string) =>
      resolveModelProviderLabel({ slug, driverKind: ProviderDriverKind.make("opencode") });
    expect(label("constructor/x")).toBe("Constructor");
    expect(label("hasOwnProperty/x")).toBe("Has Own Property");
    expect(label("valueOf/x")).toBe("Value Of");
  });

  it("falls back to the raw custom provider ID when humanizing yields no label", () => {
    const label = (slug: string) =>
      resolveModelProviderLabel({ slug, driverKind: ProviderDriverKind.make("opencode") });
    expect(label("___/x")).toBe("___");
    expect(label(".../x")).toBe("...");
  });
});
