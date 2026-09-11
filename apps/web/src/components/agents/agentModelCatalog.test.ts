import { describe, expect, it } from "@effect/vitest";
import type { ClientSettings } from "@t3tools/contracts/settings";
import type { ServerProvider } from "@t3tools/contracts";
import { agentModelOptions, visibleAgentProviders } from "./agentModelCatalog";

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
});
