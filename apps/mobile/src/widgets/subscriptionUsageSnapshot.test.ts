import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  UsageLimitSourceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  buildSubscriptionUsageSnapshot,
  createWidgetRefresher,
  WIDGET_REFRESH_INTERVAL,
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
    const snapshot = buildSubscriptionUsageSnapshot(
      presentations([provider({ displayName: "private@example.com" })]),
      deepLink,
    );
    expect(snapshot.checkedAt).toBe(now);
    expect(snapshot.providers[0]).toMatchObject({
      name: "Codex",
      windows: [{ remaining: 60 }],
      expiresAt: now + 10 * 60_000,
    });
    expect(snapshot.url).toBe(deepLink);
    expect(JSON.stringify(snapshot)).not.toContain("private@example.com");
  });
  it("clears data after removing environments and hides disabled providers", () => {
    expect(
      buildSubscriptionUsageSnapshot(new Map(), deepLink).providers.every(
        (p) => p.windows.length === 0,
      ),
    ).toBe(true);
    expect(
      buildSubscriptionUsageSnapshot(
        presentations([provider({ enabled: false })]),
        deepLink,
      ).providers.every((p) => p.windows.length === 0),
    ).toBe(true);
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
    expect(buildSubscriptionUsageSnapshot(input, deepLink).providers[0]?.detail).toBe(
      "Subscription remaining",
    );
    input.get(EnvironmentId.make("env"))!.serverConfig.providers = [];
    const snapshot = buildSubscriptionUsageSnapshot(input, deepLink);
    expect(snapshot.providers[0]?.name).toBe("Codex");
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
    expect(snapshot.providers[0]?.windows).toEqual([]);
    expect(JSON.stringify(snapshot)).not.toContain("token secret");
    expect(
      buildSubscriptionUsageSnapshot(
        presentations([
          provider({ usageLimits: { checkedAt, windows: [{ ...window, usedPercent: 0 }] } }),
        ]),
        deepLink,
      ).providers[0]?.windows[0]?.remaining,
    ).toBe(100);
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
    expect(snapshot.providers[0]?.windows).toHaveLength(6);
    expect(snapshot.providers[0]?.totalWindows).toBe(20);
    expect(snapshot.providers[0]?.windows[0]?.remaining).toBe(5);
  });
  it("marks unknown or distant reset times stale after fifteen minutes", () => {
    const snapshot = buildSubscriptionUsageSnapshot(
      presentations([
        provider({ usageLimits: { checkedAt, windows: [{ ...window, resetsAt: undefined }] } }),
      ]),
      deepLink,
    );
    expect(snapshot.providers[0]?.expiresAt).toBe(now + 15 * 60_000);
    expect(snapshot.providers[0]?.windows[0]?.reset).toBe("Reset time unavailable");
  });
  it("schedules a reset boundary without inventing a zero quota", () => {
    const snapshot = buildSubscriptionUsageSnapshot(presentations(), deepLink);
    const timeline = subscriptionUsageTimeline(snapshot, now);
    expect(timeline.map((entry) => entry.date.getTime())).toEqual([now, now + 10 * 60_000]);
    expect(timeline[1]?.props.providers[0]?.windows).toEqual([]);
    expect(subscriptionUsageTimeline(snapshot, now + 60 * 60_000)).toHaveLength(1);
  });
  it("expires providers independently without inventing a refill", () => {
    const snapshot = buildSubscriptionUsageSnapshot(
      presentations([
        provider(),
        provider({
          instanceId: ProviderInstanceId.make("claude"),
          driver: ProviderDriverKind.make("claudeAgent"),
          usageLimits: { checkedAt, windows: [{ ...window, resetsAt: undefined }] },
        }),
      ]),
      deepLink,
    );
    const timeline = subscriptionUsageTimeline(snapshot, now);
    expect(timeline.map((entry) => entry.date.getTime())).toEqual([
      now,
      now + 10 * 60_000,
      now + 15 * 60_000,
    ]);
    expect(timeline[1]?.props.providers[0]?.windows).toEqual([]);
    expect(timeline[1]?.props.providers[1]?.windows[0]?.remaining).toBe(60);
    expect(timeline[2]?.props.providers.every((provider) => provider.windows.length === 0)).toBe(
      true,
    );
  });
  it("marks a malformed check time immediately stale without storing null", () => {
    const snapshot = buildSubscriptionUsageSnapshot(
      presentations([provider({ usageLimits: { ...limits, checkedAt: "invalid" } })]),
      deepLink,
    );
    expect(snapshot.checkedAt).toBe(0);
    expect(snapshot.providers[0]).toMatchObject({ expiresAt: 0, windows: [] });
    expect(subscriptionUsageTimeline(snapshot, now)).toHaveLength(1);
    expect(JSON.stringify(snapshot)).not.toContain("null");
  });
  it("uses the freshest copy of an account across environments before pooling", () => {
    const input = presentations();
    input.set(EnvironmentId.make("other"), {
      entry: { target: { label: "Other" } },
      serverConfig: {
        providers: [
          provider({
            usageLimits: {
              checkedAt: new Date(now + 60_000).toISOString(),
              windows: [{ ...window, usedPercent: 80 }],
            },
          }),
        ],
      },
    });
    const snapshot = buildSubscriptionUsageSnapshot(input, deepLink);
    expect(snapshot.providers[0]?.detail).toBe("Subscription remaining");
    expect(snapshot.providers[0]?.windows[0]?.remaining).toBe(20);
  });
});

describe("widget refresh probes", () => {
  it("throttles each connected environment independently and retries failures", async () => {
    const probe = vi
      .fn<(id: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    const refresh = createWidgetRefresher(probe);
    await refresh([], now);
    expect(probe).not.toHaveBeenCalled();
    await refresh(["first"], now);
    await refresh(["first", "second"], now + 1);
    expect(probe.mock.calls).toEqual([["first"], ["second"]]);
    await refresh(["first"], now + WIDGET_REFRESH_INTERVAL);
    expect(probe.mock.calls).toEqual([["first"], ["second"], ["first"]]);
  });

  it("does not overlap a slow probe even after the refresh interval", async () => {
    let finish!: () => void;
    const probe = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const refresh = createWidgetRefresher(probe);
    const first = refresh(["one", "one"], now);
    await refresh(["one"], now + WIDGET_REFRESH_INTERVAL);
    expect(probe).toHaveBeenCalledTimes(1);
    finish();
    await first;
  });
});
