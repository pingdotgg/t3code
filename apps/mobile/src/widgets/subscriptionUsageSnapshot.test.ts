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
  subscriptionUsageTimeline,
  WIDGET_REFRESH_INTERVAL,
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

describe("subscription widget expiry", () => {
  const observedAt = "2026-10-21T16:45:00.000Z";
  const observedNow = Date.parse(observedAt);
  const maxAgeDeadline = Date.parse("2026-10-21T17:00:00.000Z");

  function snapshot(
    sessionReset = "2026-10-21T16:30:00.000Z",
    weeklyReset = "2026-10-28T16:45:00.000Z",
    maxWindowsPerProvider = 6,
  ) {
    return buildSubscriptionUsageSnapshot(
      presentations([
        provider({
          usageLimits: {
            checkedAt: observedAt,
            windows: [
              {
                id: "session",
                kind: "session",
                label: "5 hours",
                usedPercent: 0,
                resetsAt: sessionReset,
              },
              {
                id: "weekly",
                kind: "weekly",
                label: "Weekly",
                usedPercent: 30,
                resetsAt: weeklyReset,
              },
            ],
          },
        }),
      ]),
      deepLink,
      maxWindowsPerProvider,
    );
  }

  it.each([
    { platform: "iOS", maxWindowsPerProvider: 6 },
    { platform: "Android", maxWindowsPerProvider: Infinity },
  ])(
    "$platform keeps both freshly observed rows when only the session reset is in the past",
    ({ maxWindowsPerProvider }) => {
      const pastReset = snapshot(undefined, undefined, maxWindowsPerProvider);
      const futureReset = snapshot("2026-10-21T17:30:00.000Z", undefined, maxWindowsPerProvider);
      expect(futureReset.providers[0]).toMatchObject({
        detail: "Subscription remaining",
        expiresAt: maxAgeDeadline,
        totalWindows: 2,
        windows: [
          { kind: "weekly", remaining: 70 },
          { kind: "session", remaining: 100 },
        ],
      });
      expect(pastReset.checkedAt).toBe(observedNow);
      expect(pastReset.providers[0]).toMatchObject({
        detail: "Subscription remaining",
        expiresAt: maxAgeDeadline,
        totalWindows: 2,
        windows: [
          { kind: "weekly", remaining: 70 },
          { kind: "session", remaining: 100 },
        ],
      });
      expect(pastReset.providers[0]?.windows[1]?.reset).toMatch(/^Reset /);
      expect(futureReset.providers[0]?.windows[1]?.reset).toMatch(/^Next reset /);
    },
  );

  it("ignores resets at observation time and preserves reported past-reset usage", () => {
    const stored = buildSubscriptionUsageSnapshot(
      presentations([
        provider({
          usageLimits: {
            checkedAt: observedAt,
            windows: [{ ...window, usedPercent: 40, resetsAt: observedAt }],
          },
        }),
      ]),
      deepLink,
    );
    expect(stored.providers[0]).toMatchObject({
      expiresAt: maxAgeDeadline,
      windows: [{ remaining: 60, reset: expect.stringMatching(/^Reset /) }],
    });
  });

  it("compares resets against each provider's own observation time", () => {
    const resetAt = "2026-10-21T16:50:00.000Z";
    const stored = buildSubscriptionUsageSnapshot(
      presentations([
        provider({
          usageLimits: {
            checkedAt: observedAt,
            windows: [{ ...window, resetsAt: resetAt }],
          },
        }),
        provider({
          instanceId: ProviderInstanceId.make("claude"),
          driver: ProviderDriverKind.make("claudeAgent"),
          usageLimits: {
            checkedAt: "2026-10-21T16:55:00.000Z",
            windows: [{ ...window, resetsAt: resetAt }],
          },
        }),
      ]),
      deepLink,
    );
    expect(stored.providers).toMatchObject([
      { name: "Codex", expiresAt: Date.parse(resetAt) },
      { name: "Claude", expiresAt: Date.parse("2026-10-21T17:10:00.000Z") },
    ]);
  });

  it.each([
    {
      observation: "newer",
      resetAccount: 1,
      expiresAt: "2026-10-21T16:55:00.000Z",
      resetLabel: /^Reset /,
    },
    {
      observation: "older",
      resetAccount: 0,
      expiresAt: "2026-10-21T16:42:00.000Z",
      resetLabel: /^Next reset /,
    },
  ])(
    "compares a pooled reset with its $observation account observation",
    ({ resetAccount, expiresAt, resetLabel }) => {
      const stored = buildSubscriptionUsageSnapshot(
        presentations(
          ["2026-10-21T16:40:00.000Z", observedAt].map((accountCheckedAt, index) =>
            provider({
              instanceId: ProviderInstanceId.make(`codex-${index}`),
              auth: { status: "authenticated", email: `account-${index}@example.com` },
              usageLimits: {
                checkedAt: accountCheckedAt,
                windows: [
                  {
                    ...window,
                    resetsAt:
                      index === resetAccount
                        ? "2026-10-21T16:42:00.000Z"
                        : "2026-10-21T17:30:00.000Z",
                  },
                ],
              },
            }),
          ),
        ),
        deepLink,
      );
      expect(stored.checkedAt).toBe(Date.parse("2026-10-21T16:40:00.000Z"));
      expect(stored.providers[0]).toMatchObject({
        detail: "2 accounts · pooled",
        expiresAt: Date.parse(expiresAt),
        totalWindows: 1,
        windows: [{ remaining: 60, reset: expect.stringMatching(resetLabel) }],
      });
      expect(
        subscriptionUsageTimeline(stored, observedNow)[0]?.props.providers[0]?.windows,
      ).toHaveLength(resetAccount === 1 ? 1 : 0);
    },
  );

  it("keeps both rows in the current timeline entry despite the past session reset", () => {
    const timeline = subscriptionUsageTimeline(snapshot(), observedNow);
    expect(timeline.map((entry) => entry.date.toISOString())).toEqual([
      observedAt,
      "2026-10-21T17:00:00.000Z",
    ]);
    expect(timeline[0]?.props.providers[0]).toMatchObject({
      detail: "Subscription remaining",
      totalWindows: 2,
      windows: [
        { kind: "weekly", remaining: 70 },
        { kind: "session", remaining: 100 },
      ],
    });
    expect(timeline[1]?.props.providers[0]).toMatchObject({
      detail: "Open T3 to refresh",
      totalWindows: 0,
      windows: [],
    });
  });

  it("expires a snapshot older than 15 minutes even with future reset times", () => {
    const stored = snapshot("2026-10-21T17:30:00.000Z");
    expect(stored.providers[0]?.expiresAt).toBe(maxAgeDeadline);
    expect(subscriptionUsageTimeline(stored, Date.parse("2026-10-21T17:00:00.001Z"))).toMatchObject(
      [
        {
          props: {
            providers: [{ detail: "Open T3 to refresh", totalWindows: 0, windows: [] }],
          },
        },
      ],
    );
  });

  it("expires at a future reset sooner than the 15 minute age limit", () => {
    const resetAt = "2026-10-21T16:50:00.000Z";
    const stored = snapshot(resetAt);
    expect(stored.providers[0]?.expiresAt).toBe(Date.parse(resetAt));
    const timeline = subscriptionUsageTimeline(stored, observedNow);
    expect(timeline.map((entry) => entry.date.toISOString())).toEqual([observedAt, resetAt]);
    expect(timeline[0]?.props.providers[0]?.windows).toHaveLength(2);
    expect(timeline[1]?.props.providers[0]).toMatchObject({
      detail: "Open T3 to refresh",
      totalWindows: 0,
      windows: [],
    });
  });
});

describe("widget refresh probes", () => {
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
