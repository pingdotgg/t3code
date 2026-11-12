import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type LimitAccount,
  collectProviderUsageLimits,
  sameUsageLimitCommandCoverage,
  withUsageLimitsCommands,
  collectLimitAccounts,
  collectExternalUsageLinks,
  collectLimitNotices,
  collectLimitPools,
  elapsedShare,
  exhaustedUsageWindow,
  paceOf,
  paceRemainingPercent,
  usesChatGptSharing,
  resolveNewThreadModelSelection,
} from "./usageLimits.ts";

const now = Date.parse("2026-09-03T12:00:00.000Z");

const window = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 40,
  windowDurationMins: 300,
  resetsAt: "2026-09-03T14:00:00.000Z",
} as const;

function provider(overrides: Partial<ServerProvider>): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-03T11:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}










describe("/usage-limits", () => {
  const limits = { checkedAt: "2026-09-03T11:00:00.000Z", windows: [window] };
  const selected = provider({
    usageLimits: limits,
    auth: { status: "authenticated", email: "same@example.com" },
  });
  const sources = [
    {
      id: UsageLimitSourceId.make("hub"),
      kind: "cliproxy" as const,
      label: "Accounts",
      checkedAt: limits.checkedAt,
      accounts: [
        {
          id: "duplicate",
          driver: selected.driver,
          email: "SAME@example.com",
          usageLimits: limits,
        },
        { id: "oss", driver: selected.driver, plan: "Codex OSS", usageLimits: limits },
        { id: "other-provider", driver: ProviderDriverKind.make("claude"), usageLimits: limits },
      ],
    },
  ];

  it("uses hub credit balances and redemption targets in the composer, including native duplicates", () => {
    const hubs = sources.map((source) => ({
      ...source,
      accounts: source.accounts.map((account) => ({
        ...account,
        usageLimits: {
          ...account.usageLimits,
          resetCredits: { availableCount: 2, nextCreditId: `${account.id}-credit` },
        },
      })),
    }));
    const report = collectProviderUsageLimits(selected.instanceId, [selected], hubs, now);
    expect(report?.accounts[0]?.limits.resetCredits?.availableCount).toBe(2);
    expect(report?.accounts[0]?.resetCreditInput).toEqual({
      sourceId: "hub",
      accountId: "duplicate",
      creditId: "duplicate-credit",
    });
    expect(report?.accounts.find((account) => account.id === "hub:oss")?.resetCreditInput).toEqual({
      sourceId: "hub",
      accountId: "oss",
      creditId: "oss-credit",
    });
  });

  it("gives a hub credit to no native row when its email is signed in to two workspaces", () => {
    const workspaces = ["ws-a", "ws-b"].map((workspaceId) =>
      provider({
        instanceId: ProviderInstanceId.make(workspaceId),
        usageLimits: limits,
        auth: { status: "authenticated", email: "same@example.com", workspaceId },
      }),
    );
    const hub = [
      {
        ...sources[0]!,
        accounts: [
          {
            id: "duplicate",
            driver: selected.driver,
            email: "same@example.com",
            usageLimits: { ...limits, resetCredits: { availableCount: 2, nextCreditId: "c" } },
          },
        ],
      },
    ];
    const report = collectProviderUsageLimits(workspaces[0]!.instanceId, workspaces, hub, now);
    expect(report?.accounts.map((account) => account.resetCreditInput)).toEqual([
      { instanceId: "ws-a" },
      { instanceId: "ws-b" },
      { sourceId: "hub", accountId: "duplicate", creditId: "c" },
    ]);
  });

  it("redeems a native duplicate through the hub even when the native snapshot is fresher", () => {
    const fresher = provider({
      usageLimits: {
        checkedAt: "2026-09-03T11:30:00.000Z",
        windows: [window],
        resetCredits: { availableCount: 3, nextCreditId: "native-credit" },
      },
      auth: { status: "authenticated", email: "same@example.com" },
    });
    const stale = [
      {
        id: UsageLimitSourceId.make("hub"),
        kind: "cliproxy" as const,
        label: "Accounts",
        checkedAt: limits.checkedAt,
        accounts: [
          {
            id: "duplicate",
            driver: fresher.driver,
            email: "SAME@example.com",
            usageLimits: {
              ...limits,
              resetCredits: { availableCount: 2, nextCreditId: "hub-credit" },
            },
          },
        ],
      },
    ];
    const report = collectProviderUsageLimits(fresher.instanceId, [fresher], stale, now);
    expect(report?.accounts[0]?.resetCreditInput).toEqual({
      sourceId: "hub",
      accountId: "duplicate",
      creditId: "hub-credit",
    });
    expect(report?.accounts[0]?.limits.resetCredits?.availableCount).toBe(3);
  });

  it("labels hub rows by account id without .json", () => {
    const hub = [
      {
        ...sources[0]!,
        label: "CLIProxyAPI",
        accounts: [
          {
            id: "claude-b@example.com.json",
            driver: selected.driver,
            email: "b@example.com",
            usageLimits: limits,
          },
          { id: "team-seat.json", driver: selected.driver, usageLimits: limits },
        ],
      },
    ];
    const report = collectProviderUsageLimits(selected.instanceId, [selected], hub, now);
    expect(
      report?.accounts.filter((account) => account.sourceLabel).map((account) => account.label),
    ).toEqual(["CLIProxyAPI · claude-b@example.com", "CLIProxyAPI · team-seat"]);
  });

  it("keeps unidentified custom instances separate, filtering by driver", () => {
    const report = collectProviderUsageLimits(
      selected.instanceId,
      [
        selected,
        provider({
          instanceId: ProviderInstanceId.make("codex-work"),
          displayName: "Work",
          usageLimits: { ...limits, resetCredits: { availableCount: 2 } },
        }),
        provider({
          driver: ProviderDriverKind.make("claude"),
          instanceId: ProviderInstanceId.make("claude"),
          usageLimits: limits,
        }),
      ],
      sources,
      now,
    );
    expect(report?.createdAt).toBe("2026-09-03T12:00:00.000Z");
    expect(report?.accounts.map((account) => account.id)).toEqual([
      "codex",
      "codex-work",
      "hub:oss",
    ]);
    expect(report?.accounts[0]).toMatchObject({
      instanceId: selected.instanceId,
      email: selected.auth.email,
    });
    expect(report?.accounts[1]).toMatchObject({
      displayName: "Work",
      limits: { resetCredits: { availableCount: 2 } },
    });
    expect(report?.accounts[2]).toMatchObject({
      label: "Accounts · oss",
      sourceLabel: "CLI Proxy",
      plan: "Codex OSS",
    });
    expect(report?.notices).toEqual([]);
  });

  it("keeps the freshest usable native duplicate and the freshest native credits in either order", () => {
    const failed = provider({
      auth: selected.auth,
      usageLimits: {
        ...limits,
        checkedAt: "2026-09-03T11:40:00.000Z",
        unavailable: { reason: "probeFailed" },
      },
    });
    const credited = provider({
      instanceId: ProviderInstanceId.make("codex-credit"),
      auth: selected.auth,
      usageLimits: {
        checkedAt: "2026-09-03T11:20:00.000Z",
        windows: [{ ...window, usedPercent: 50 }],
        resetCredits: { availableCount: 2 },
      },
    });
    const staleCredit = provider({
      ...credited,
      instanceId: ProviderInstanceId.make("codex-stale-credit"),
      usageLimits: { ...limits, resetCredits: { availableCount: 3 } },
    });
    const freshest = provider({
      instanceId: ProviderInstanceId.make("codex-fresh"),
      auth: selected.auth,
      usageLimits: {
        checkedAt: "2026-09-03T11:30:00.000Z",
        windows: [{ ...window, usedPercent: 55 }],
      },
    });
    const duplicates = [failed, staleCredit, credited, freshest];
    for (const providers of [duplicates, duplicates.toReversed()]) {
      const report = collectProviderUsageLimits(failed.instanceId, providers, sources, now);
      expect(report?.accounts.map((account) => account.id)).toEqual(["codex-fresh", "hub:oss"]);
      expect(report?.accounts[0]).toMatchObject({
        limits: {
          checkedAt: "2026-09-03T11:30:00.000Z",
          windows: [{ usedPercent: 55 }],
          resetCredits: { availableCount: 2 },
        },
        resetCreditInput: { instanceId: "codex-credit" },
      });
      expect(report?.accounts[0]?.limits.unavailable).toBeUndefined();
    }
  });

  it("merges native workspace duplicates only while the workspace evidence is unambiguous", () => {
    const known = provider({
      ...selected,
      instanceId: ProviderInstanceId.make("workspace-a"),
      auth: { ...selected.auth, workspaceId: "ws-a" },
    });
    const fresh = provider({
      ...known,
      instanceId: ProviderInstanceId.make("workspace-a-fresh"),
      usageLimits: { ...limits, checkedAt: "2026-09-03T11:30:00.000Z" },
    });
    const natives = [known, fresh, selected];
    expect(
      collectProviderUsageLimits(selected.instanceId, natives, [], now)?.accounts.map(
        (account) => account.id,
      ),
    ).toEqual(["workspace-a-fresh"]);

    const unreadable = provider({
      instanceId: ProviderInstanceId.make("workspace-b"),
      auth: { ...selected.auth, workspaceId: "ws-b" },
    });
    expect(
      collectProviderUsageLimits(
        selected.instanceId,
        [...natives, unreadable],
        [],
        now,
      )?.accounts.map((account) => account.id),
    ).toEqual(["workspace-a-fresh", "codex"]);
    expect(
      collectProviderUsageLimits(
        selected.instanceId,
        [...natives, { ...unreadable, usageLimits: limits }],
        [],
        now,
      )?.accounts.map((account) => account.id),
    ).toEqual(["workspace-a-fresh", "codex", "workspace-b"]);
  });

  it("supports a source-only provider and keeps duplicates when the native probe failed", () => {
    expect(
      collectProviderUsageLimits(selected.instanceId, [provider({})], sources, now)?.accounts.map(
        (account) => account.id,
      ),
    ).toEqual(["hub:duplicate", "hub:oss"]);
    const failed = provider({ usageLimits: { ...limits, unavailable: { reason: "probeFailed" } } });
    expect(
      collectProviderUsageLimits(selected.instanceId, [failed], sources, now)?.accounts.map(
        (account) => account.id,
      ),
    ).toEqual(["codex", "hub:duplicate", "hub:oss"]);
    expect(collectProviderUsageLimits(selected.instanceId, [provider({})], [], now)).toBeNull();
    expect(
      collectProviderUsageLimits(
        selected.instanceId,
        [provider({ enabled: false, usageLimits: limits })],
        [],
        now,
      ),
    ).toBeNull();
  });

  it("surfaces source errors only for sources that carry the selected driver", () => {
    const failing = { ...sources[0]!, error: "token expired" };
    expect(
      collectProviderUsageLimits(selected.instanceId, [selected], [failing], now)?.notices,
    ).toEqual(["Accounts: token expired"]);
    const claudeOnly = { ...failing, accounts: failing.accounts.slice(2) };
    expect(
      collectProviderUsageLimits(selected.instanceId, [selected], [claudeOnly], now)?.notices,
    ).toEqual([]);
    const unreadable = { ...failing, accounts: [] };
    expect(
      collectProviderUsageLimits(selected.instanceId, [selected], [unreadable], now)?.notices,
    ).toEqual(["Accounts: token expired"]);
    const sourceOnly = collectProviderUsageLimits(
      selected.instanceId,
      [provider({})],
      [unreadable],
      now,
    );
    expect(sourceOnly?.accounts).toEqual([]);
    expect(sourceOnly?.notices).toEqual(["Accounts: token expired"]);
  });

  it("advertises global and workspace commands only for providers present in Limits", () => {
    const withWorkspace = provider({
      workspaceSnapshots: [
        { cwd: "/tmp/project", checkedAt: limits.checkedAt, slashCommands: [], skills: [] },
      ],
    });
    const [supported] = withUsageLimitsCommands([withWorkspace], sources);
    expect(supported?.slashCommands.map((command) => command.name)).toEqual(["usage-limits"]);
    expect(
      supported?.workspaceSnapshots?.[0]?.slashCommands.map((command) => command.name),
    ).toEqual(["usage-limits"]);
    expect(withUsageLimitsCommands([withWorkspace], [])[0]?.slashCommands).toEqual([]);
    const ownCommand = provider({
      slashCommands: [{ name: "usage-limits", description: "Provider's own" }],
    });
    expect(withUsageLimitsCommands([ownCommand], [])[0]?.slashCommands).toEqual([
      { name: "usage-limits", description: "Provider's own" },
    ]);
    const unreadable = { ...sources[0]!, accounts: [], error: "token expired" };
    expect(
      withUsageLimitsCommands([withWorkspace], [unreadable])[0]?.slashCommands.map(
        (command) => command.name,
      ),
    ).toEqual(["usage-limits"]);
    expect(
      withUsageLimitsCommands([selected], [])[0]?.slashCommands.map((command) => command.name),
    ).toEqual(["usage-limits"]);
  });
});

