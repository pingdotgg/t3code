import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  highestUsageWindow,
  providersWithReportedUsage,
  selectCollapsedUsageProvider,
} from "./ProviderUsagePill.logic";

const checkedAt = "2026-09-04T08:00:00.000Z";

function usageWindow(id: string, usedPercent: number): ServerProviderUsageWindow {
  return {
    id,
    kind: id === "weekly" ? "weekly" : "session",
    label: id === "weekly" ? "Weekly" : "Five hour",
    usedPercent,
  };
}

function provider(
  instanceId: string,
  driver: string,
  windows: readonly ServerProviderUsageWindow[] | null,
  options: {
    readonly unavailable?: "unsupported" | "probeFailed";
    readonly enabled?: boolean;
  } = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    displayName: instanceId,
    enabled: options.enabled ?? true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    ...(windows === null
      ? {}
      : {
          usageLimits: {
            checkedAt,
            windows: [...windows],
            ...(options.unavailable ? { unavailable: { reason: options.unavailable } } : {}),
          },
        }),
  };
}

describe("provider usage pill selection", () => {
  it("shows only usable providers with live reported windows", () => {
    const codex = provider("codex", "codex", [usageWindow("five_hour", 42)]);
    const unsupported = provider("claudeAgent", "claudeAgent", [], {
      unavailable: "unsupported",
    });
    const failed = provider("grok", "grok", [usageWindow("weekly", 73)], {
      unavailable: "probeFailed",
    });
    const noLimits = provider("cursor", "cursor", null);
    const disabled = provider("opencode", "opencode", [usageWindow("weekly", 90)], {
      enabled: false,
    });

    expect(providersWithReportedUsage([codex, unsupported, failed, noLimits, disabled])).toEqual([
      codex,
    ]);
  });

  it("uses the active session provider even when another provider is fuller", () => {
    const codex = provider("codex", "codex", [
      usageWindow("five_hour", 18),
      usageWindow("weekly", 31),
    ]);
    const claude = provider("claudeAgent", "claudeAgent", [usageWindow("weekly", 82)]);
    const providers = providersWithReportedUsage([codex, claude]);

    expect(
      selectCollapsedUsageProvider(providers, ProviderInstanceId.make("codex"))?.instanceId,
    ).toBe("codex");
    expect(highestUsageWindow(providers[0]!).usedPercent).toBe(31);
  });

  it("falls back to the provider with the highest current usage", () => {
    const codex = provider("codex", "codex", [usageWindow("weekly", 42)]);
    const claude = provider("claudeAgent", "claudeAgent", [usageWindow("five_hour", 67)]);
    const providers = providersWithReportedUsage([codex, claude]);

    expect(
      selectCollapsedUsageProvider(providers, ProviderInstanceId.make("grok"))?.instanceId,
    ).toBe("claudeAgent");
  });

  it("renders nothing when no provider reports usage", () => {
    expect(selectCollapsedUsageProvider(providersWithReportedUsage([]), null)).toBeNull();
  });
});
