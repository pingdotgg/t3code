import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  collectSidebarPlanUsage,
  formatPlanUsageReset,
  highestPlanUsagePercent,
  sidebarPlanUsageTone,
} from "./SidebarPlanUsage.logic.ts";

function provider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("claude"),
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: "Claude",
    enabled: true,
    installed: true,
    version: "2.1.219",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-24T18:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

describe("sidebar plan usage", () => {
  it("collects every provider window with environment context", () => {
    const entries = collectSidebarPlanUsage([
      {
        environmentId: "environment-local",
        label: "Local",
        serverConfig: {
          providers: [
            provider({
              planUsage: {
                checkedAt: "2026-08-24T18:01:00.000Z",
                windows: [
                  { id: "seven_day", label: "All models", usedPercent: 10, resetsAt: null },
                  { id: "seven_day_fable", label: "Fable", usedPercent: 18, resetsAt: null },
                ],
              },
            }),
          ],
        },
      },
    ]);

    expect(
      entries.map(({ providerLabel, windowLabel, usedPercent }) => ({
        providerLabel,
        windowLabel,
        usedPercent,
      })),
    ).toEqual([
      { providerLabel: "Claude", windowLabel: "All models", usedPercent: 10 },
      { providerLabel: "Claude", windowLabel: "Fable", usedPercent: 18 },
    ]);
    expect(highestPlanUsagePercent(entries)).toBe(18);
  });

  it("uses stable environment ids in keys when labels collide", () => {
    const usageProvider = provider({
      planUsage: {
        checkedAt: "2026-08-24T18:01:00.000Z",
        windows: [{ id: "seven_day", label: "All models", usedPercent: 10, resetsAt: null }],
      },
    });
    const entries = collectSidebarPlanUsage([
      {
        environmentId: "environment-a",
        label: "Local",
        serverConfig: { providers: [usageProvider] },
      },
      {
        environmentId: "environment-b",
        label: "Local",
        serverConfig: { providers: [usageProvider] },
      },
    ]);

    expect(new Set(entries.map((entry) => entry.key)).size).toBe(2);
  });

  it("formats reset times with the host locale", () => {
    const resetsAt = "2026-08-24T22:00:00.000Z";
    expect(formatPlanUsageReset(resetsAt, "en-GB")).toBe(
      new Intl.DateTimeFormat("en-GB", {
        weekday: "short",
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(resetsAt)),
    );
  });

  it("uses the requested warning thresholds", () => {
    expect(sidebarPlanUsageTone(69.9)).toBe("muted");
    expect(sidebarPlanUsageTone(70)).toBe("warning");
    expect(sidebarPlanUsageTone(89.9)).toBe("warning");
    expect(sidebarPlanUsageTone(90)).toBe("danger");
  });

  it("reports no percentage before a provider has returned plan usage", () => {
    expect(
      collectSidebarPlanUsage([
        { environmentId: "environment-local", label: "Local", serverConfig: null },
      ]),
    ).toEqual([]);
    expect(highestPlanUsagePercent([])).toBeNull();
  });
});
