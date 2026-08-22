import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, type ServerProviderUsageWindow } from "@t3tools/contracts";

import { formatUtcDateTimestamp } from "../../timestampFormat";
import {
  collectQuotaGroups,
  formatUsageResetDate,
  getUsageWindowKey,
  GROK_FREE_TIER_USAGE_MESSAGE,
  isGrokFreeTier,
  providerQuotaNotice,
  sharedUsageResetAt,
  shouldShowProviderQuota,
} from "./ProviderQuotaLimits";

describe("provider usage presentation", () => {
  it("omits malformed reset timestamps", () => {
    expect(formatUsageResetDate("not-a-date")).toBeNull();
    expect(formatUsageResetDate(undefined)).toBeNull();
  });

  it("formats a reset instant with the requested clock", () => {
    const resetAt = new Date(2026, 7, 16, 15, 30).toISOString();
    expect(formatUsageResetDate(resetAt, "24-hour")).toContain(
      new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(resetAt)),
    );
  });

  it("formats a date-only UTC midnight reset without inventing a local clock", () => {
    expect(formatUsageResetDate("2026-09-16T00:00:00.000Z")).toBe(
      formatUtcDateTimestamp("2026-09-16T00:00:00.000Z"),
    );
  });

  it("treats identical window resets as one shared instant", () => {
    const resetsAt = "2026-09-16T00:00:00.000Z";
    expect(
      sharedUsageResetAt([
        { kind: "weekly", label: "Auto", usedPercent: 8, resetsAt },
        { kind: "weekly", label: "API", usedPercent: 0, resetsAt },
      ]),
    ).toBe(resetsAt);
    expect(
      sharedUsageResetAt([
        {
          kind: "session",
          label: "Session",
          usedPercent: 10,
          resetsAt: "2026-08-16T12:00:00.000Z",
        },
        { kind: "weekly", label: "Weekly", usedPercent: 20, resetsAt: "2026-08-23T12:00:00.000Z" },
      ]),
    ).toBeUndefined();
  });

  it("uses the label to distinguish otherwise identical OpenCode windows", () => {
    const openCodeGo: ServerProviderUsageWindow = {
      kind: "session",
      label: "OpenCode Go",
      usedPercent: 10,
    };
    const openCodeZen: ServerProviderUsageWindow = {
      kind: "session",
      label: "OpenCode Zen",
      usedPercent: 50,
    };

    expect(getUsageWindowKey(openCodeGo)).not.toBe(getUsageWindowKey(openCodeZen));
  });
});

describe("shouldShowProviderQuota", () => {
  it("hides disabled or uninstalled providers", () => {
    expect(
      shouldShowProviderQuota({
        enabled: false,
        installed: true,
        usageLimits: {
          source: "claudeStatusProbe",
          available: true,
          checkedAt: "2026-08-16T00:00:00.000Z",
          windows: [{ kind: "session", label: "Session", usedPercent: 10 }],
        },
      } as never),
    ).toBe(false);
    expect(
      shouldShowProviderQuota({
        enabled: true,
        installed: false,
      } as never),
    ).toBe(false);
  });

  it("shows enabled providers even without usage windows", () => {
    expect(
      shouldShowProviderQuota({
        driver: "grok",
        enabled: true,
        installed: true,
      } as never),
    ).toBe(true);
  });

  it("hides OpenCode because its usage cannot be tracked here", () => {
    expect(
      shouldShowProviderQuota({
        driver: "opencode",
        enabled: true,
        installed: true,
        usageLimits: {
          source: "opencodeManaged",
          available: true,
          checkedAt: "2026-08-16T00:00:00.000Z",
          windows: [{ kind: "session", label: "OpenCode Go", usedPercent: 10 }],
        },
      } as never),
    ).toBe(false);
  });
});

describe("providerQuotaNotice", () => {
  it("tells Grok free-tier accounts that usage is paid-only", () => {
    expect(
      isGrokFreeTier({
        driver: "grok",
        auth: { status: "authenticated", label: "Free", type: "Free" },
      } as never),
    ).toBe(true);
    expect(
      providerQuotaNotice({
        driver: "grok",
        auth: { status: "authenticated", email: "user@example.com", label: "Free", type: "Free" },
        usageLimits: {
          source: "grokStatusProbe",
          available: false,
          checkedAt: "2026-08-16T00:00:00.000Z",
          reason: "Could not read usage limits for this Grok account.",
          windows: [],
        },
      } as never),
    ).toBe(GROK_FREE_TIER_USAGE_MESSAGE);
  });

  it("keeps Cursor probe failures as the notice", () => {
    expect(
      providerQuotaNotice({
        driver: "cursor",
        auth: { status: "authenticated" },
        usageLimits: {
          source: "cursorStatusProbe",
          available: false,
          checkedAt: "2026-08-16T00:00:00.000Z",
          reason: "Could not read usage limits for this Cursor account.",
          windows: [],
        },
      } as never),
    ).toBe("Could not read usage limits for this Cursor account.");
  });
});

describe("collectQuotaGroups", () => {
  it("omits environment labels when only one environment has quota data", () => {
    const environmentId = EnvironmentId.make("env-1");
    const groups = collectQuotaGroups(
      new Map([
        [
          environmentId,
          {
            providers: [
              {
                instanceId: "claude",
                driver: "claudeAgent",
                enabled: true,
                installed: true,
                usageLimits: {
                  source: "claudeStatusProbe",
                  available: true,
                  checkedAt: "2026-08-16T00:00:00.000Z",
                  windows: [{ kind: "session", label: "Session", usedPercent: 10 }],
                },
              },
            ],
          } as never,
        ],
      ]),
      new Map([[environmentId, { entry: { target: { label: "Home" } } }]]),
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.environmentLabel).toBeNull();
  });

  it("includes Grok free-tier accounts that have no usage windows", () => {
    const environmentId = EnvironmentId.make("env-1");
    const groups = collectQuotaGroups(
      new Map([
        [
          environmentId,
          {
            providers: [
              {
                instanceId: "grok",
                driver: "grok",
                enabled: true,
                installed: true,
                auth: { status: "authenticated", label: "Free", type: "Free" },
              },
            ],
          } as never,
        ],
      ]),
      new Map(),
    );

    expect(groups[0]?.providers).toHaveLength(1);
    expect(providerQuotaNotice(groups[0]!.providers[0]!)).toBe(GROK_FREE_TIER_USAGE_MESSAGE);
  });
});
