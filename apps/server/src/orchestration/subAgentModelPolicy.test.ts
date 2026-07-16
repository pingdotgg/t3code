import { ProviderDriverKind, ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { expect, it } from "@effect/vitest";

import {
  applySubAgentModelPolicy,
  clampSubAgentEffortByModel,
  enforceSubAgentStandardMode,
  isSubAgentThreadTitle,
  MODEL_CLAMPS,
  withSubAgentThreadTitle,
} from "./subAgentModelPolicy.ts";

const codex = ProviderDriverKind.make("codex");
const claude = ProviderDriverKind.make("claudeAgent");

const selection = (
  model: string,
  options?: ModelSelection["options"],
  instanceId = "codex",
): ModelSelection => ({
  instanceId: ProviderInstanceId.make(instanceId),
  model,
  ...(options !== undefined ? { options } : {}),
});

const effortCapabilities = (currentValue?: string) =>
  createModelCapabilities({
    optionDescriptors: [
      {
        id: "effort",
        label: "Reasoning effort",
        type: "select",
        ...(currentValue !== undefined ? { currentValue } : {}),
        options: [
          { id: "minimal", label: "Minimal" },
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium" },
          { id: "high", label: "High" },
          { id: "xhigh", label: "XHigh" },
          { id: "max", label: "Max", isDefault: true },
          { id: "ultracode", label: "Ultracode" },
          { id: "ultrathink", label: "Ultrathink" },
        ],
        promptInjectedValues: ["ultrathink"],
      },
    ],
  });

it("recognizes product-native sub-agent thread titles", () => {
  expect(isSubAgentThreadTitle("Agent: reviewer")).toBe(true);
  expect(isSubAgentThreadTitle("  agent: reviewer")).toBe(true);
  expect(isSubAgentThreadTitle("Top-level agent discussion")).toBe(false);
  expect(withSubAgentThreadTitle("renamed reviewer")).toBe("Agent: renamed reviewer");
  expect(withSubAgentThreadTitle("agent: renamed reviewer")).toBe("Agent: renamed reviewer");
});

it("forces both Claude fast mode and Codex priority tier to standard", () => {
  const selection: ModelSelection = {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
    options: [
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
      { id: "serviceTier", value: "priority" },
    ],
  };

  expect(enforceSubAgentStandardMode(selection)).toEqual({
    ...selection,
    options: [
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: false },
      { id: "serviceTier", value: "default" },
    ],
  });
});

it("leaves top-level-compatible selections without fast controls unchanged", () => {
  const selection: ModelSelection = {
    instanceId: ProviderInstanceId.make("claudex"),
    model: "claudex-sol",
    options: [{ id: "effort", value: "high" }],
  };

  expect(enforceSubAgentStandardMode(selection)).toBe(selection);
});

it("maps every explicit model clamp to its replacement", () => {
  for (const [requested, clamp] of Object.entries(MODEL_CLAMPS)) {
    const result = applySubAgentModelPolicy({
      driver: requested.startsWith("gpt-") ? codex : claude,
      model: requested,
      availableModels: [clamp.model],
      selection: selection(requested),
    });

    expect(result.model).toBe(clamp.model);
    expect(result.notices.some((notice) => notice.startsWith(`model ${requested} →`))).toBe(true);
  }
});

it("uses slug and driver fallbacks for unknown models", () => {
  expect(
    applySubAgentModelPolicy({
      driver: claude,
      model: "claudex-new-model",
      availableModels: ["claudex-luna"],
      selection: selection("claudex-new-model", undefined, "claudex"),
    }).model,
  ).toBe("claudex-luna");
  expect(
    applySubAgentModelPolicy({
      driver: claude,
      model: "claude-future-6",
      availableModels: ["claude-sonnet-5"],
      selection: selection("claude-future-6", undefined, "claude"),
    }).model,
  ).toBe("claude-sonnet-5");
  expect(
    applySubAgentModelPolicy({
      driver: codex,
      model: "gpt-5.3-codex-next",
      availableModels: ["gpt-5.6-luna"],
      selection: selection("gpt-5.3-codex-next"),
    }).model,
  ).toBe("gpt-5.6-luna");
});

it("bans outdated gpt-5 slugs by prefix", () => {
  const result = applySubAgentModelPolicy({
    driver: codex,
    model: "gpt-5.1-custom",
    availableModels: ["gpt-5.6-luna"],
    selection: selection("gpt-5.1-custom"),
  });

  expect(result.model).toBe("gpt-5.6-luna");
  expect(result.notices[0]).toContain("outdated Codex generation");
});

it("leaves allowed models untouched", () => {
  for (const [model, driver, instanceId] of [
    ["claudex-luna", claude, "claudex"],
    ["gpt-5.6-luna", codex, "codex"],
    ["gpt-5.6", codex, "codex"],
    ["gpt-5.6-terra", codex, "codex"],
    ["claude-sonnet-5", claude, "claude"],
    ["claude-opus-4-8", claude, "claude"],
  ] as const) {
    const original = selection(model, undefined, instanceId);
    const result = applySubAgentModelPolicy({
      driver,
      model,
      availableModels: [model],
      selection: original,
    });

    expect(result.model).toBe(model);
    if (model === "claudex-luna" || model === "gpt-5.6-luna") {
      expect(result.selection.options).toContainEqual({ id: "effort", value: "xhigh" });
    } else {
      expect(result.selection).toEqual(original);
      expect(result.notices).toEqual([]);
    }
  }
});

it("sets Luna defaults and clamps effort above the model cap", () => {
  const luna = applySubAgentModelPolicy({
    driver: claude,
    model: "claudex-luna",
    availableModels: ["claudex-luna"],
    selection: selection("claudex-luna", undefined, "claudex"),
    capabilitiesFor: () => effortCapabilities(),
  });
  expect(luna.selection.options).toContainEqual({ id: "effort", value: "xhigh" });
  expect(
    luna.notices.some((notice) => /effort (?:default|max) → xhigh \(sub-agent cap\)/.test(notice)),
  ).toBe(true);

  const other = applySubAgentModelPolicy({
    driver: claude,
    model: "claude-opus-4-8",
    availableModels: ["claude-opus-4-8"],
    selection: selection("claude-opus-4-8", [{ id: "effort", value: "max" }], "claude"),
    capabilitiesFor: () => effortCapabilities(),
  });
  expect(other.selection.options).toContainEqual({ id: "effort", value: "high" });
  expect(other.notices).toContain("effort max → high (sub-agent cap)");
});

it("leaves non-ranked and prompt-injected effort values alone", () => {
  const nonRanked = applySubAgentModelPolicy({
    driver: claude,
    model: "claude-opus-4-8",
    availableModels: ["claude-opus-4-8"],
    selection: selection(
      "claude-opus-4-8",
      [{ id: "effort", value: "provider-default" }],
      "claude",
    ),
    capabilitiesFor: () => effortCapabilities(),
  });
  expect(nonRanked.selection.options).toContainEqual({ id: "effort", value: "provider-default" });
  expect(nonRanked.notices).toEqual([]);

  const promptInjected = applySubAgentModelPolicy({
    driver: claude,
    model: "claude-opus-4-8",
    availableModels: ["claude-opus-4-8"],
    selection: selection("claude-opus-4-8", [{ id: "effort", value: "ultrathink" }], "claude"),
    capabilitiesFor: () => effortCapabilities(),
  });
  expect(promptInjected.selection.options).toContainEqual({ id: "effort", value: "ultrathink" });
  expect(promptInjected.notices).toEqual([]);
});

it("generates notices for effort and standard-mode clamps", () => {
  const result = applySubAgentModelPolicy({
    driver: codex,
    model: "gpt-5.6",
    availableModels: ["gpt-5.6"],
    selection: selection("gpt-5.6", [
      { id: "reasoningEffort", value: "max" },
      { id: "fastMode", value: true },
      { id: "serviceTier", value: "priority" },
    ]),
    capabilitiesFor: () => effortCapabilities(),
  });

  expect(result.notices).toEqual(
    expect.arrayContaining([
      "effort max → high (sub-agent cap)",
      "option fastMode forced to standard sub-agent mode",
      "option serviceTier forced to standard sub-agent mode",
    ]),
  );
});

it("uses the first allowed catalog model when a replacement is unavailable", () => {
  const result = applySubAgentModelPolicy({
    driver: codex,
    model: "gpt-5.5",
    availableModels: ["gpt-5.6-sol", "gpt-5.6"],
    selection: selection("gpt-5.5"),
  });

  expect(result.model).toBe("gpt-5.6");
  expect(result.notices[0]).toContain("using an allowed catalog model");
});

it("uses capabilities for the effective model after a model clamp", () => {
  const requestedModel = "claude-fable-5";
  const effectiveModel = "claude-opus-4-8";
  const result = applySubAgentModelPolicy({
    driver: claude,
    model: requestedModel,
    availableModels: [effectiveModel],
    selection: selection(requestedModel, undefined, "claude"),
    capabilitiesFor: (model) =>
      model === effectiveModel ? effortCapabilities("max") : effortCapabilities("low"),
  });

  expect(result.model).toBe(effectiveModel);
  expect(result.selection.options).toContainEqual({ id: "effort", value: "high" });
  expect(result.notices).toContain("effort max → high (sub-agent cap)");
});

it("clamps effort without model capabilities", () => {
  expect(
    clampSubAgentEffortByModel(
      selection("claude-opus-4-8", [{ id: "effort", value: "max" }], "claude"),
    ),
  ).toEqual(selection("claude-opus-4-8", [{ id: "effort", value: "high" }], "claude"));
  expect(clampSubAgentEffortByModel(selection("claudex-luna", undefined, "claudex"))).toEqual(
    selection("claudex-luna", [{ id: "effort", value: "xhigh" }], "claudex"),
  );
});
