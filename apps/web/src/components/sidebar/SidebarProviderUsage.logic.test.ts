import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatResetsAt,
  formatUpdatedAgo,
  getProviderUsageRows,
  providerUsageWindowTone,
} from "./SidebarProviderUsage.logic";

const NOW_MS = Date.parse("2026-08-06T12:00:00.000Z");

const makeProvider = (overrides: Partial<ServerProvider>): ServerProvider =>
  ({
    instanceId: ProviderInstanceId.make("claudeAgent"),
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: "Claude",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-06T11:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  }) as ServerProvider;

describe("providerUsageWindowTone", () => {
  it("derives tones from percent thresholds", () => {
    expect(providerUsageWindowTone({ key: "k", label: "5h", usedPercent: 10 })).toBe("default");
    expect(providerUsageWindowTone({ key: "k", label: "5h", usedPercent: 70 })).toBe("warning");
    expect(providerUsageWindowTone({ key: "k", label: "5h", usedPercent: 90 })).toBe("critical");
  });

  it("lets provider-reported status escalate the tone", () => {
    expect(
      providerUsageWindowTone({ key: "k", label: "5h", usedPercent: 10, status: "warning" }),
    ).toBe("warning");
    expect(
      providerUsageWindowTone({ key: "k", label: "5h", usedPercent: 10, status: "exhausted" }),
    ).toBe("critical");
  });
});

describe("formatResetsAt", () => {
  it("formats future resets as compact durations", () => {
    expect(formatResetsAt("2026-08-06T14:10:00.000Z", NOW_MS)).toBe("resets in 2h 10m");
    expect(formatResetsAt("2026-08-06T12:05:00.000Z", NOW_MS)).toBe("resets in 5m");
    expect(formatResetsAt("2026-08-08T13:00:00.000Z", NOW_MS)).toBe("resets in 2d 1h");
  });

  it("handles past, missing, and invalid timestamps", () => {
    expect(formatResetsAt("2026-08-06T11:00:00.000Z", NOW_MS)).toBe("resets soon");
    expect(formatResetsAt(undefined, NOW_MS)).toBeUndefined();
    expect(formatResetsAt("not-a-date", NOW_MS)).toBeUndefined();
  });
});

describe("formatUpdatedAgo", () => {
  it("formats recency labels", () => {
    expect(formatUpdatedAgo("2026-08-06T11:59:30.000Z", NOW_MS)).toBe("updated just now");
    expect(formatUpdatedAgo("2026-08-06T11:55:00.000Z", NOW_MS)).toBe("updated 5m ago");
    expect(formatUpdatedAgo("2026-08-06T09:00:00.000Z", NOW_MS)).toBe("updated 3h ago");
    expect(formatUpdatedAgo("not-a-date", NOW_MS)).toBe("updated recently");
  });
});

describe("getProviderUsageRows", () => {
  it("builds one row per provider with usage and skips the rest", () => {
    const providers = [
      makeProvider({
        usage: {
          windows: [
            {
              key: "five_hour",
              label: "5h",
              usedPercent: 42.4,
              resetsAt: "2026-08-06T14:00:00.000Z",
            },
            { key: "seven_day", label: "1w", usedPercent: 91 },
          ],
          updatedAt: "2026-08-06T11:58:00.000Z",
        },
      }),
      makeProvider({
        instanceId: ProviderInstanceId.make("codex"),
        driver: ProviderDriverKind.make("codex"),
        displayName: "Codex",
      }),
    ] as ReadonlyArray<ServerProvider>;

    const rows = getProviderUsageRows(providers, NOW_MS);

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.key).toBe("claudeAgent");
    expect(row.name).toBe("Claude");
    expect(row.tone).toBe("critical");
    expect(row.updatedAgoLabel).toBe("updated 2m ago");
    expect(row.windows.map((window) => [window.label, window.percentLabel, window.tone])).toEqual([
      ["5h", "42%", "default"],
      ["1w", "91%", "critical"],
    ]);
    expect(row.windows[0]!.resetsAtLabel).toBe("resets in 2h");
  });

  it("skips disabled providers and empty usage snapshots", () => {
    const providers = [
      makeProvider({
        enabled: false,
        usage: {
          windows: [{ key: "five_hour", label: "5h", usedPercent: 42 }],
          updatedAt: "2026-08-06T11:58:00.000Z",
        },
      }),
      makeProvider({
        instanceId: ProviderInstanceId.make("codex"),
        driver: ProviderDriverKind.make("codex"),
        usage: { windows: [], updatedAt: "2026-08-06T11:58:00.000Z" },
      }),
    ] as ReadonlyArray<ServerProvider>;

    expect(getProviderUsageRows(providers, NOW_MS)).toHaveLength(0);
  });

  it("falls back to a capitalized driver slug when displayName is missing", () => {
    const providers = [
      makeProvider({
        displayName: undefined,
        usage: {
          windows: [{ key: "five_hour", label: "5h", usedPercent: 1 }],
          updatedAt: "2026-08-06T11:58:00.000Z",
        },
      }),
    ] as ReadonlyArray<ServerProvider>;

    expect(getProviderUsageRows(providers, NOW_MS)[0]!.name).toBe("ClaudeAgent");
  });
});
