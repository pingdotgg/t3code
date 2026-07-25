import { describe, expect, it } from "@effect/vitest";
import type { ServerProviderModel } from "@t3tools/contracts";

import {
  getClaudeDiscoveredModelCapabilities,
  mergeClaudeDiscoveredModels,
  parseClaudeSdkDiscoveredModels,
  registerClaudeDiscoveredModels,
} from "./claudeModelDiscovery.ts";

// Mirrors the real `models` payload reported by Claude Code 2.1.218 through
// the Agent SDK initialization result.
const CLI_2_1_218_MODELS = [
  {
    value: "default",
    displayName: "Default (recommended)",
    description: "Opus 4.8 with 1M context · Best for everyday, complex tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
    supportsFastMode: true,
    supportsAutoMode: true,
  },
  {
    value: "claude-fable-5[1m]",
    displayName: "Fable",
    description: "Fable 5 · Most capable for your hardest and longest-running tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
    supportsAutoMode: true,
  },
  {
    value: "sonnet",
    displayName: "Sonnet",
    description: "Sonnet 4.6 · Efficient for routine tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "max"],
    supportsAdaptiveThinking: true,
    supportsAutoMode: true,
  },
  {
    value: "haiku",
    displayName: "Haiku",
    description: "Haiku 4.5 · Fastest for quick answers",
  },
];

function makeBuiltInModel(slug: string): ServerProviderModel {
  return { slug, name: slug, isCustom: false, capabilities: null };
}

describe("parseClaudeSdkDiscoveredModels", () => {
  it("returns an empty list for missing or malformed payloads", () => {
    expect(parseClaudeSdkDiscoveredModels(undefined)).toEqual([]);
    expect(parseClaudeSdkDiscoveredModels(null)).toEqual([]);
    expect(parseClaudeSdkDiscoveredModels({})).toEqual([]);
    expect(parseClaudeSdkDiscoveredModels("claude-opus-5")).toEqual([]);
    expect(parseClaudeSdkDiscoveredModels([null, 42, {}, { value: "" }])).toEqual([]);
  });

  it("drops non-model picker entries and resolves aliases to built-in slugs", () => {
    const models = parseClaudeSdkDiscoveredModels(CLI_2_1_218_MODELS);
    expect(models.map((model) => model.slug)).toEqual([
      "claude-fable-5",
      "claude-sonnet-5",
      "claude-haiku-4-5",
    ]);
  });

  it("surfaces newly released models reported by full id", () => {
    const models = parseClaudeSdkDiscoveredModels([
      ...CLI_2_1_218_MODELS,
      {
        value: "claude-opus-5[1m]",
        displayName: "Opus",
        description: "Opus 5 · Latest and greatest",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
        supportsFastMode: true,
      },
    ]);

    const opus5 = models.find((model) => model.slug === "claude-opus-5");
    expect(opus5).toBeDefined();
    expect(opus5?.name).toBe("Opus");
    expect(opus5?.isCustom).toBe(false);
  });

  it("builds effort, fast-mode, and context-window capabilities from CLI metadata", () => {
    const models = parseClaudeSdkDiscoveredModels([
      {
        value: "claude-opus-5[1m]",
        displayName: "Opus",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
        supportsFastMode: true,
      },
    ]);

    const capabilities = models[0]?.capabilities;
    const descriptors = capabilities?.optionDescriptors ?? [];
    const effort = descriptors.find((descriptor) => descriptor.id === "effort");
    expect(effort?.type).toBe("select");
    if (effort?.type === "select") {
      expect(effort.options.map((option) => option.id)).toEqual([
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]);
      expect(effort.options.find((option) => option.isDefault)?.id).toBe("high");
    }
    expect(descriptors.some((descriptor) => descriptor.id === "fastMode")).toBe(true);
    const contextWindow = descriptors.find((descriptor) => descriptor.id === "contextWindow");
    expect(contextWindow?.type).toBe("select");
    if (contextWindow?.type === "select") {
      expect(contextWindow.options.map((option) => option.id)).toEqual(["200k", "1m"]);
    }
  });

  it("omits the context-window option when the CLI reports no [1m] variant", () => {
    const models = parseClaudeSdkDiscoveredModels([
      { value: "claude-opus-5", displayName: "Opus", supportsEffort: true },
    ]);
    const descriptors = models[0]?.capabilities?.optionDescriptors ?? [];
    expect(descriptors.some((descriptor) => descriptor.id === "contextWindow")).toBe(false);
    // No effort levels reported: fall back to the full standard set.
    const effort = descriptors.find((descriptor) => descriptor.id === "effort");
    if (effort?.type === "select") {
      expect(effort.options.map((option) => option.id)).toEqual([
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]);
    }
  });

  it("filters unknown effort levels and omits effort when the model does not support it", () => {
    const models = parseClaudeSdkDiscoveredModels([
      {
        value: "claude-mini-1",
        supportsEffort: true,
        supportedEffortLevels: ["low", "ludicrous", "high"],
      },
      { value: "claude-nano-1" },
    ]);

    const mini = models.find((model) => model.slug === "claude-mini-1");
    const effort = mini?.capabilities?.optionDescriptors?.find(
      (descriptor) => descriptor.id === "effort",
    );
    if (effort?.type === "select") {
      expect(effort.options.map((option) => option.id)).toEqual(["low", "high"]);
    }

    const nano = models.find((model) => model.slug === "claude-nano-1");
    expect(nano?.capabilities?.optionDescriptors ?? []).toEqual([]);
  });

  it("dedupes entries that normalize to the same slug", () => {
    const models = parseClaudeSdkDiscoveredModels([
      { value: "claude-opus-5", displayName: "Opus" },
      { value: "claude-opus-5[1m]", displayName: "Opus" },
      { value: " claude-opus-5 ", displayName: "Opus duplicate" },
    ]);
    expect(models.map((model) => model.slug)).toEqual(["claude-opus-5"]);
  });
});

describe("mergeClaudeDiscoveredModels", () => {
  it("keeps built-ins first and appends discovered-only models", () => {
    const builtIns = [makeBuiltInModel("claude-opus-4-8"), makeBuiltInModel("claude-sonnet-5")];
    const discovered = [makeBuiltInModel("claude-sonnet-5"), makeBuiltInModel("claude-opus-5")];

    const merged = mergeClaudeDiscoveredModels(builtIns, discovered);
    expect(merged.map((model) => model.slug)).toEqual([
      "claude-opus-4-8",
      "claude-sonnet-5",
      "claude-opus-5",
    ]);
    // Built-in entry wins over the discovered duplicate.
    expect(merged[1]).toBe(builtIns[1]);
  });

  it("returns the built-in list unchanged when nothing was discovered", () => {
    const builtIns = [makeBuiltInModel("claude-opus-4-8")];
    expect(mergeClaudeDiscoveredModels(builtIns, [])).toBe(builtIns);
  });
});

describe("discovered model capability registry", () => {
  it("serves capabilities for registered slugs and clears stale entries", () => {
    const discovered = parseClaudeSdkDiscoveredModels([
      {
        value: "claude-registry-test-model",
        supportsEffort: true,
        supportedEffortLevels: ["low", "high"],
      },
    ]);
    registerClaudeDiscoveredModels(discovered);

    const capabilities = getClaudeDiscoveredModelCapabilities("claude-registry-test-model");
    const effort = capabilities?.optionDescriptors?.find(
      (descriptor) => descriptor.id === "effort",
    );
    if (effort?.type === "select") {
      expect(effort.options.map((option) => option.id)).toEqual(["low", "high"]);
    }

    registerClaudeDiscoveredModels([]);
    expect(getClaudeDiscoveredModelCapabilities("claude-registry-test-model")).toBeUndefined();
    expect(getClaudeDiscoveredModelCapabilities(undefined)).toBeUndefined();
  });
});
