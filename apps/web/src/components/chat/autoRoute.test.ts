import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import { describeAutoRoute } from "./autoRoute";

const now = Date.parse("2026-11-13T12:00:00.000Z");

function provider(
  id: string,
  displayName: string,
  driver: string,
  models: ReadonlyArray<{ slug: string; name: string }>,
  usedPercent: number,
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make(driver),
    displayName,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-13T11:00:00.000Z",
    models: models.map((model) => ({ ...model, isCustom: false, capabilities: null })),
    slashCommands: [],
    skills: [],
    usageLimits: {
      windows: [
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          usedPercent,
          resetsAt: "2026-11-13T15:00:00.000Z",
        },
      ],
    },
  } as unknown as ServerProvider;
}

const claudeModels = [
  { slug: "claude-fable-5-2", name: "Claude Fable 5.2" },
  { slug: "claude-opus-5-5", name: "Claude Opus 5.5" },
  { slug: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
  { slug: "auto", name: "Auto" },
];

describe("describeAutoRoute", () => {
  it("names the Claude model and account Auto would use", () => {
    const entries = deriveProviderInstanceEntries([
      provider("claudeAuto", "Auto", "claudeAgent", claudeModels, 95),
      provider("claudeAutoB", "Auto B", "claudeAgent", claudeModels, 10),
    ]);
    const medium = describeAutoRoute({ entries, now });
    expect(medium?.driverKind).toBe("claudeAgent");
    expect(medium?.label).toMatch(/^.*Opus 5\.5 \(B\)$/);

    const high = describeAutoRoute({ entries, options: [{ id: "effort", value: "high" }], now });
    expect(high?.label).toMatch(/Fable 5\.2 \(B\)$/);
  });

  it("names another provider when both Claude accounts are used up", () => {
    const entries = deriveProviderInstanceEntries([
      provider("claudeAuto", "Auto", "claudeAgent", claudeModels, 100),
      provider("claudeAutoB", "Auto B", "claudeAgent", claudeModels, 100),
      provider("grok", "Grok Build", "grok", [{ slug: "grok-4.7", name: "Grok 4.7" }], 0),
    ]);
    expect(describeAutoRoute({ entries, now })).toMatchObject({
      driverKind: "grok",
      label: expect.stringMatching(/Grok 4\.7 \(Grok Build\)$/),
    });
  });
});
