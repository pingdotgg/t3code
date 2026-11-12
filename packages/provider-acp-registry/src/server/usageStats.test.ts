import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { AcpRegistrySettings } from "../settings.ts";
import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
import { checkAcpRegistryProviderStatus } from "./driver.ts";
import { usageStatsToUsageLimits } from "./usageStats.ts";

const decodeSettings = Schema.decodeSync(AcpRegistrySettings);

const NOW = "2026-11-12T20:00:00.000Z";

// Fixture mirrors zcode-acp 0.84+ `account/usage_stats` — the `zcode` section
// (Start Plan grants) plus the classic `glm` Coding Plan section.
const ZCODE_STATS = {
  glm: { kind: "unavailable" },
  opencode: { kind: "not_configured" },
  ollama: { kind: "not_configured" },
  cliproxy: { kind: "not_configured" },
  zcode: {
    kind: "success",
    planId: "zcode-v3-start-plan-1112",
    planName: "ZCODE GLOBAL BUILD",
    windows: [
      {
        key: "ent-zcode-v3-start-plan-1112-1",
        label: "ZCODE GLOBAL BUILD · GLM-5.3-Flash",
        usagePercent: 66.83,
        resetsAt: 1794531600000,
        modelIds: ["glm-5.3-flash"],
        usedUnits: 200485508,
        totalUnits: 300000000,
        remainingUnits: 99514492,
        oneTime: true,
      },
    ],
  },
};

describe("usageStatsToUsageLimits", () => {
  it("maps a zcode Start Plan grant into one window", () => {
    const limits = usageStatsToUsageLimits(ZCODE_STATS, NOW);
    expect(limits).toBeDefined();
    expect(limits?.checkedAt).toBe(NOW);
    expect(limits?.windows).toHaveLength(1);
    const window = limits?.windows[0];
    expect(window?.id).toBe("zcode:ent-zcode-v3-start-plan-1112-1");
    expect(window?.kind).toBe("other");
    expect(window?.label).toBe("ZCODE GLOBAL BUILD · GLM-5.3-Flash");
    expect(window?.usedPercent).toBeCloseTo(66.83, 2);
    expect(window?.resetsAt).toBe("2026-11-13T01:00:00.000Z");
    expect(window?.modelIds).toEqual(["glm-5.3-flash"]);
  });

  it("maps glm coding-plan items with kind from the label", () => {
    const limits = usageStatsToUsageLimits(
      {
        glm: {
          kind: "success",
          level: "pro",
          items: [
            { key: "token_5h", label: "5h", usedPercent: 12, nextResetTime: 1794531600000 },
            { key: "token_7", label: "Week", usedPercent: 40 },
          ],
        },
      },
      NOW,
    );
    expect(limits?.windows).toHaveLength(2);
    expect(limits?.windows[0]?.kind).toBe("session");
    expect(limits?.windows[0]?.id).toBe("glm:token_5h");
    expect(limits?.windows[1]?.kind).toBe("weekly");
    expect(limits?.windows[1]?.resetsAt).toBeUndefined();
  });

  it("prefers zcode windows and merges glm when both succeed", () => {
    const limits = usageStatsToUsageLimits(
      {
        ...ZCODE_STATS,
        glm: {
          kind: "success",
          items: [{ key: "token_5h", label: "5h", usedPercent: 7 }],
        },
      },
      NOW,
    );
    expect(limits?.windows).toHaveLength(2);
  });

  it("returns undefined for unavailable sections and malformed payloads", () => {
    expect(usageStatsToUsageLimits({ zcode: { kind: "unavailable" } }, NOW)).toBeUndefined();
    expect(usageStatsToUsageLimits({}, NOW)).toBeUndefined();
    expect(usageStatsToUsageLimits(null, NOW)).toBeUndefined();
    expect(usageStatsToUsageLimits("nope", NOW)).toBeUndefined();
    expect(
      usageStatsToUsageLimits({ zcode: { kind: "success", windows: [{}] } }, NOW),
    ).toBeUndefined();
  });

  it("clamps out-of-range percentages", () => {
    const limits = usageStatsToUsageLimits(
      {
        zcode: {
          kind: "success",
          windows: [{ key: "k", label: "L", usagePercent: 142 }],
        },
      },
      NOW,
    );
    expect(limits?.windows[0]?.usedPercent).toBe(100);
  });
});

describe("checkAcpRegistryProviderStatus usageLimits attach", () => {
  const identity = {
    instanceId: ProviderInstanceId.make("acpRegistry_usage_test"),
    displayName: "Test ACP",
    accentColor: undefined,
    continuationKey: "acpRegistry:instance:acpRegistry_usage_test",
  };
  const catalogWithInspection = (inspection: AcpRegistrySupport.AcpRegistryInspection) => ({
    search: () => Effect.die("unused search"),
    prepare: () => Effect.die("unused prepare"),
    inspect: () => Effect.succeed(inspection),
    resolve: () => Effect.die("unused resolve"),
    uninstallManagedBinary: () => Effect.die("unused uninstall"),
  });
  const readyInspection = {
    status: "ready" as const,
    agentId: "test-agent",
    version: "1.0.0",
    distribution: "binary" as const,
  };
  const probedLimits = usageStatsToUsageLimits(ZCODE_STATS, "2026-11-12T20:00:00.000Z");

  it.effect("attaches probed usageLimits to the ready snapshot", () =>
    checkAcpRegistryProviderStatus(
      {
        ...identity,
        settings: decodeSettings({ agentId: "test-agent" }),
        cwd: "/w",
        environment: {},
      },
      () =>
        Effect.succeed({
          probe: {
            instanceId: identity.instanceId,
            ready: true as const,
            icon: null,
            authMethods: [],
            models: [],
            currentModelId: null,
            configOptions: [],
            sessionManagement: {
              canList: false,
              canLoad: false,
              canResume: false,
              canLogout: false,
              canDelete: false,
              canConfigureProviders: false,
            },
          },
          slashCommands: [],
          skills: [],
          ...(probedLimits ? { usageLimits: probedLimits } : {}),
        }),
    ).pipe(
      Effect.provideService(
        AcpRegistrySupport.AcpRegistryCatalog,
        catalogWithInspection(readyInspection),
      ),
      Effect.map((snapshot) => {
        expect(snapshot.usageLimits).toEqual(probedLimits);
        expect(snapshot.usageLimits?.windows[0]?.label).toContain("ZCODE GLOBAL BUILD");
      }),
    ),
  );

  it.effect("omits usageLimits when the probe carries none", () =>
    checkAcpRegistryProviderStatus(
      {
        ...identity,
        settings: decodeSettings({ agentId: "test-agent" }),
        cwd: "/w",
        environment: {},
      },
      () =>
        Effect.succeed({
          probe: {
            instanceId: identity.instanceId,
            ready: true as const,
            icon: null,
            authMethods: [],
            models: [],
            currentModelId: null,
            configOptions: [],
            sessionManagement: {
              canList: false,
              canLoad: false,
              canResume: false,
              canLogout: false,
              canDelete: false,
              canConfigureProviders: false,
            },
          },
          slashCommands: [],
          skills: [],
        }),
    ).pipe(
      Effect.provideService(
        AcpRegistrySupport.AcpRegistryCatalog,
        catalogWithInspection(readyInspection),
      ),
      Effect.map((snapshot) => {
        expect(snapshot.usageLimits).toBeUndefined();
      }),
    ),
  );
});
