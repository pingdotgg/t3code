import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import type { ProviderOptionDescriptor } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resolveSubagentModelTraits } from "./subagentDisplay.js";

describe("resolveSubagentModelTraits", () => {
  const claudeInstance = ProviderInstanceId.make("claude");
  const codexInstance = ProviderInstanceId.make("codex");
  const effort = {
    id: "effort",
    label: "Reasoning",
    type: "select" as const,
    options: [
      { id: "high", label: "High", isDefault: true },
      { id: "xhigh", label: "Extra High" },
    ],
  };
  const claude = (extra: ReadonlyArray<ProviderOptionDescriptor> = []) => ({
    driver: ProviderDriverKind.make("claudeAgent"),
    models: [
      {
        slug: "claude-opus-4-7",
        name: "Claude Opus 4.7",
        aliases: ["claude-opus-4-7-20260101"],
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            effort,
            { id: "fastMode", label: "Fast Mode", type: "boolean" as const },
            ...extra,
          ],
        },
      },
    ],
  });
  const codex = (tiers: ReadonlyArray<{ id: string; label: string }>) => ({
    driver: ProviderDriverKind.make("codex"),
    models: [
      {
        slug: "gpt-6.1-sol",
        name: "GPT-6.1-Sol",
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            { ...effort, id: "reasoningEffort" },
            { id: "serviceTier", label: "Service Tier", type: "select" as const, options: tiers },
          ],
        },
      },
    ],
  });
  const codexTiers = [
    { id: "default", label: "Standard" },
    { id: "priority", label: "Fast" },
  ];
  const selection = (
    instanceId: ProviderInstanceId,
    model: string,
    options: ReadonlyArray<{ id: string; value: string | boolean }>,
  ) => ({ instanceId, model, options });

  it("falls back to an app-owned child's selection but not a provider-native one's", () => {
    const traits = (origin: "app_owned" | "provider_native") =>
      resolveSubagentModelTraits({
        model: "claude-opus-4-7-20260101",
        providerInstanceId: claudeInstance,
        origin,
        childThread: {
          modelSelection: selection(claudeInstance, "claude-opus-4-7", [
            { id: "effort", value: "xhigh" },
            { id: "fastMode", value: true },
          ]),
        },
        provider: claude(),
      });
    expect(traits("app_owned")).toEqual({ effortLabel: "Extra High", speed: "fast" });
    expect(traits("provider_native")).toEqual({ effortLabel: null, speed: null });
    expect(
      resolveSubagentModelTraits({
        model: "claude-opus-4-7",
        providerInstanceId: claudeInstance,
        origin: "provider_native",
        modelSelection: selection(claudeInstance, "claude-opus-4-7", [
          { id: "effort", value: "high" },
        ]),
      }).effortLabel,
    ).toBeNull();
    expect(
      resolveSubagentModelTraits({
        model: "claude-opus-4-7",
        providerInstanceId: claudeInstance,
        origin: "provider_native",
        modelSelection: selection(claudeInstance, "claude-opus-4-7", [
          { id: "effort", value: "high" },
        ]),
        provider: claude(),
      }).effortLabel,
    ).toBeNull();
  });

  it("prefers the subagent's own selection over its child thread's", () => {
    expect(
      resolveSubagentModelTraits({
        model: "claude-opus-4-7",
        providerInstanceId: claudeInstance,
        origin: "app_owned",
        modelSelection: selection(claudeInstance, "claude-opus-4-7", [
          { id: "effort", value: "high" },
          { id: "fastMode", value: false },
        ]),
        childThread: {
          modelSelection: selection(claudeInstance, "claude-opus-4-7", [
            { id: "effort", value: "xhigh" },
            { id: "fastMode", value: true },
          ]),
        },
        provider: claude(),
      }),
    ).toEqual({ effortLabel: "High", speed: null });
  });

  it.each([
    ["cursor", "reasoning_effort"],
    ["antigravity", "thinking_level"],
  ] as const)("names %s reasoning effort", (driver, optionId) => {
    const cursorInstance = ProviderInstanceId.make("cursor");
    expect(
      resolveSubagentModelTraits({
        model: "gpt-6.1-sol",
        providerInstanceId: cursorInstance,
        origin: "provider_native",
        modelSelection: selection(cursorInstance, "gpt-6.1-sol", [
          { id: optionId, value: "xhigh" },
        ]),
        provider: {
          driver: ProviderDriverKind.make(driver),
          models: [
            {
              slug: "gpt-6.1-sol",
              name: "GPT-6.1-Sol",
              isCustom: false,
              capabilities: { optionDescriptors: [{ ...effort, id: optionId }] },
            },
          ],
        },
      }),
    ).toEqual({ effortLabel: "Extra High", speed: null });
  });

  it("calls out a Codex fast tier and leaves the standard tier unmarked", () => {
    const traits = (tier: string) =>
      resolveSubagentModelTraits({
        model: "gpt-6.1-sol",
        providerInstanceId: codexInstance,
        origin: "provider_native",
        modelSelection: selection(codexInstance, "gpt-6.1-sol", [
          { id: "reasoningEffort", value: "high" },
          { id: "serviceTier", value: tier },
        ]),
        provider: codex(codexTiers),
      });
    expect(traits("priority")).toEqual({ effortLabel: "High", speed: "fast" });
    expect(traits("default")).toEqual({ effortLabel: "High", speed: null });
  });

  it("omits speed when a tier shares its id with the standard choice", () => {
    expect(
      resolveSubagentModelTraits({
        model: "gpt-6.1-sol",
        providerInstanceId: codexInstance,
        origin: "provider_native",
        modelSelection: selection(codexInstance, "gpt-6.1-sol", [
          { id: "serviceTier", value: "default" },
        ]),
        provider: codex([
          { id: "default", label: "Standard" },
          { id: "default", label: "Fast" },
        ]),
      }).speed,
    ).toBeNull();
  });

  it("claims no speed the provider does not run", () => {
    // Claude ignores service tiers, and a tier the catalog does not list is unknown.
    expect(
      resolveSubagentModelTraits({
        model: "claude-opus-4-7",
        providerInstanceId: claudeInstance,
        origin: "provider_native",
        modelSelection: selection(claudeInstance, "claude-opus-4-7", [
          { id: "serviceTier", value: "priority" },
        ]),
        provider: claude([
          { id: "serviceTier", label: "Speed", type: "select", options: codexTiers },
        ]),
      }).speed,
    ).toBeNull();
    expect(
      resolveSubagentModelTraits({
        model: "gpt-6.1-sol",
        providerInstanceId: codexInstance,
        origin: "provider_native",
        modelSelection: selection(codexInstance, "gpt-6.1-sol", [
          { id: "serviceTier", value: "Fast" },
        ]),
        provider: codex(codexTiers),
      }).speed,
    ).toBeNull();
  });

  it("ignores a selection for another model or provider instance", () => {
    const options = [
      { id: "effort", value: "xhigh" },
      { id: "fastMode", value: true },
    ];
    expect(
      resolveSubagentModelTraits({
        model: "claude-haiku-4-5",
        providerInstanceId: claudeInstance,
        origin: "provider_native",
        modelSelection: selection(claudeInstance, "claude-opus-4-7", options),
        provider: claude(),
      }),
    ).toEqual({ effortLabel: null, speed: null });
    expect(
      resolveSubagentModelTraits({
        model: "claude-opus-4-7",
        providerInstanceId: claudeInstance,
        origin: "provider_native",
        modelSelection: selection(
          ProviderInstanceId.make("claude-work"),
          "claude-opus-4-7",
          options,
        ),
        provider: claude(),
      }),
    ).toEqual({ effortLabel: null, speed: null });
  });
});
