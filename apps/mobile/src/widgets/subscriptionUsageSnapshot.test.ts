import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  UsageLimitSourceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  buildSubscriptionUsageSnapshot,
  subscriptionUsageTimeline,
} from "./subscriptionUsageSnapshot";

const checkedAt = "2026-09-05T12:00:00.000Z";
const now = Date.parse(checkedAt);
const window = {
  id: "session",
  kind: "session",
  label: "5 hours",
  usedPercent: 40,
  resetsAt: "2026-09-05T12:10:00.000Z",
} as const;
const limits = { checkedAt, windows: [window] };
const deepLink = "t3code-dev://settings/usage?tab=limits";
function provider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated", email: "private@example.com" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: limits,
    ...overrides,
  };
}
function presentations(providers: readonly ServerProvider[] = [provider()]) {
  return new Map([
    [
      EnvironmentId.make("env"),
      { entry: { target: { label: "Remote" } }, serverConfig: { providers } },
    ],
  ]);
}

describe("subscription widget snapshots", () => {
  it("uses provider data and its observation time without exposing account emails", () => {
    const snapshot = buildSubscriptionUsageSnapshot(presentations(), deepLink);
    expect(snapshot.rows[0]).toMatchObject({
      label: "Codex",
      usedPercent: 40,
      checkedAt: now,
      expiresAt: now + 10 * 60_000,
    });
    expect(snapshot.deepLink).toBe(deepLink);
    expect(JSON.stringify(snapshot)).not.toContain("private@example.com");
  });
  it("clears data after removing environments and hides disabled providers", () => {
    expect(buildSubscriptionUsageSnapshot(new Map(), deepLink).rows).toEqual([]);
    expect(
      buildSubscriptionUsageSnapshot(presentations([provider({ enabled: false })]), deepLink).rows,
    ).toEqual([]);
  });
  it("uses upstream deduplication for a native account also present in a proxy hub", () => {
    const input = new Map([
      [
        EnvironmentId.make("env"),
        {
          entry: { target: { label: "Remote" } },
          serverConfig: {
            providers: [provider()],
            usageLimitSources: [
              {
                id: UsageLimitSourceId.make("hub"),
                kind: "cliproxy" as const,
                label: "Hub",
                checkedAt,
                accounts: [
                  {
                    id: "account",
                    driver: ProviderDriverKind.make("codex"),
                    email: " PRIVATE@example.com ",
                    usageLimits: limits,
                  },
                ],
              },
            ],
          },
        },
      ],
    ]);
    expect(buildSubscriptionUsageSnapshot(input, deepLink).rows).toHaveLength(1);
    input.get(EnvironmentId.make("env"))!.serverConfig.providers = [];
    const snapshot = buildSubscriptionUsageSnapshot(input, deepLink);
    expect(snapshot.rows[0]?.label).toBe("Hub · Codex 1");
    expect(JSON.stringify(snapshot)).not.toContain("example.com");
  });
  it("keeps unavailable quotas distinct from zero usage and omits provider error messages", () => {
    const snapshot = buildSubscriptionUsageSnapshot(
      presentations([
        provider({
          usageLimits: {
            ...limits,
            unavailable: { reason: "probeFailed", message: "token secret" },
          },
        }),
      ]),
      deepLink,
    );
    expect(snapshot.rows[0]).toMatchObject({ window: "Limits unavailable" });
    expect(snapshot.rows[0]).not.toHaveProperty("usedPercent");
    expect(JSON.stringify(snapshot)).not.toContain("token secret");
    expect(
      buildSubscriptionUsageSnapshot(
        presentations([
          provider({ usageLimits: { checkedAt, windows: [{ ...window, usedPercent: 0 }] } }),
        ]),
        deepLink,
      ).rows[0]?.usedPercent,
    ).toBe(0);
  });
  it("bounds OS storage and puts the most constrained windows first", () => {
    const windows = Array.from({ length: 20 }, (_, index) => ({
      ...window,
      id: `${index}`,
      usedPercent: index * 5,
    }));
    const snapshot = buildSubscriptionUsageSnapshot(
      presentations([provider({ usageLimits: { checkedAt, windows } })]),
      deepLink,
    );
    expect(snapshot.rows).toHaveLength(8);
    expect(snapshot.totalRows).toBe(20);
    expect(snapshot.rows[0]?.usedPercent).toBe(95);
  });
  it("marks unknown or distant reset times stale after thirty minutes", () => {
    const snapshot = buildSubscriptionUsageSnapshot(
      presentations([
        provider({ usageLimits: { checkedAt, windows: [{ ...window, resetsAt: undefined }] } }),
      ]),
      deepLink,
    );
    expect(snapshot.rows[0]?.expiresAt).toBe(now + 30 * 60_000);
    expect(snapshot.rows[0]?.resetLabel).toBe("Reset time unavailable");
  });
  it("schedules a reset boundary without inventing a zero quota", () => {
    const snapshot = buildSubscriptionUsageSnapshot(presentations(), deepLink);
    const timeline = subscriptionUsageTimeline(snapshot, now);
    expect(timeline.map((entry) => entry.date.getTime())).toEqual([now, now + 10 * 60_000]);
    expect(timeline[1]?.props.rows[0]?.usedPercent).toBe(40);
    expect(subscriptionUsageTimeline(snapshot, now + 60 * 60_000)).toHaveLength(1);
  });
  it("marks a malformed check time immediately stale without changing the quota", () => {
    const snapshot = buildSubscriptionUsageSnapshot(
      presentations([provider({ usageLimits: { ...limits, checkedAt: "invalid" } })]),
      deepLink,
    );
    expect(snapshot.rows[0]).toMatchObject({ checkedAt: 0, expiresAt: 0, usedPercent: 40 });
    expect(subscriptionUsageTimeline(snapshot, now)).toHaveLength(1);
    expect(JSON.stringify(snapshot)).not.toContain("null");
  });
});
