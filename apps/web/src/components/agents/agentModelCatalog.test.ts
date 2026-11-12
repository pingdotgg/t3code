import { describe, expect, it } from "@effect/vitest";
import type { ClientSettings } from "@t3tools/contracts/settings";
import type { ServerProvider, ServerProviderModel } from "@t3tools/contracts";
import {
  agentModelOptions,
  agentThinkingChoices,
  presetProviderLabel,
  visibleAgentProviders,
} from "./agentModelCatalog";

const provider = {
  instanceId: "opencode",
  driver: "opencode",
  displayName: "OpenCode",
  enabled: true,
  models: [
    { slug: "deepseek/deepseek-flash", name: "DeepSeek Flash", isCustom: false },
    { slug: "deepseek-api/deepseek-flash", name: "DeepSeek Flash", isCustom: false },
    { slug: "opencode/claude", name: "Claude", isCustom: false },
  ],
} as unknown as ServerProvider;
const settings = {
  providerModelPreferences: { opencode: { hiddenModels: ["opencode/claude"], modelOrder: [] } },
} as unknown as ClientSettings;

describe("agent model catalog", () => {
  it("keeps distinct OpenCode routes and omits models hidden on the selected machine", () => {
    const mac = visibleAgentProviders("mac", [provider], settings);
    const windows = visibleAgentProviders("windows", [provider], { providerModelPreferences: {} });
    expect(
      agentModelOptions([...mac, ...windows], ["mac"], "OpenCode").map((model) => model.slug),
    ).toEqual(["deepseek-api/deepseek-flash", "deepseek/deepseek-flash"]);
    expect(agentModelOptions([...mac, ...windows], ["windows"], "OpenCode")[0]?.slug).toBe(
      "opencode/claude",
    );
  });
  it("deduplicates identical routes across machines and excludes disabled providers", () => {
    const mac = visibleAgentProviders("mac", [provider], settings);
    expect(agentModelOptions([...mac, ...mac], [], "OpenCode")).toHaveLength(2);
    expect(
      agentModelOptions(
        mac.map((p) => ({ ...p, enabled: false })),
        [],
        "OpenCode",
      ),
    ).toEqual([]);
  });
  it("maps a preset's provider driver to its label and keeps an unavailable one as written", () => {
    expect(presetProviderLabel([provider], "opencode")).toBe("OpenCode");
    expect(presetProviderLabel([provider], "OpenCode")).toBe("OpenCode");
    expect(presetProviderLabel([{ ...provider, enabled: false }], "opencode")).toBe("opencode");
    expect(presetProviderLabel([provider], "claudeAgent")).toBe("claudeAgent");
  });
  it("offers the model's reasoning levels and keeps a saved level the model no longer lists", () => {
    const model = {
      capabilities: {
        optionDescriptors: [
          { id: "fastMode", label: "Fast", type: "boolean" },
          {
            id: "effort",
            label: "Effort",
            type: "select",
            options: [
              { id: "low", label: "Low" },
              { id: "high", label: "High", isDefault: true },
              { id: "ultrathink", label: "Ultrathink" },
            ],
            promptInjectedValues: ["ultrathink"],
          },
        ],
      },
    } as unknown as ServerProviderModel;
    expect(agentThinkingChoices(model, "high").map((choice) => choice.value)).toEqual([
      "low",
      "high",
    ]);
    expect(agentThinkingChoices(model, "max").at(-1)).toEqual({
      value: "max",
      label: "max (unlisted)",
    });
    expect(agentThinkingChoices(undefined, "")).toEqual([]);
  });
});
