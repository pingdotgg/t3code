import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  UsageLimitSourceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildAndroidSubscriptionUsageSnapshot,
  collectSubscriptionWidgetQuotas,
  androidWidgetRefreshDeadlines,
  withAndroidWidgetSnapshots,
} from "./androidSubscriptionUsageSnapshot";
import { buildSubscriptionUsageSnapshot } from "./subscriptionUsageSnapshot";
import {
  DEFAULT_WIDGET_CONFIGURATION,
  resolveWidgetPreferences,
  toggleWidgetSelection,
  type SubscriptionWidgetConfiguration,
} from "./subscriptionWidgetPreferences";

const checkedAt = "2026-10-10T12:00:00.000Z";
const now = Date.parse(checkedAt);
function provider(id: string, name: string, used = 40, driver = "codex"): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make(driver),
    displayName: name,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated", email: `${id}@example.com` },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt,
      credentialFingerprint: `credential-${id}`,
      windows: [
        {
          id: "primary",
          kind: "session",
          label: "Session",
          usedPercent: used,
          resetsAt: "2026-10-10T12:10:00.000Z",
        },
        {
          id: "secondary",
          kind: "weekly",
          label: "Weekly",
          usedPercent: used + 10,
          resetsAt: "2026-10-15T12:00:00.000Z",
        },
      ],
    },
  };
}
function presentations() {
  return new Map([
    [
      EnvironmentId.make("laptop"),
      {
        entry: { target: { label: "Laptop" } },
        connection: { phase: "connected" },
        serverConfig: {
          providers: [
            provider("personal", "Personal"),
            provider("work", "Work", 80),
            provider("claude", "Writing", 20, "claudeAgent"),
          ],
        },
      },
    ],
  ]);
}
function build(patch: Partial<SubscriptionWidgetConfiguration> = {}) {
  return buildAndroidSubscriptionUsageSnapshot(presentations(), {
    ...DEFAULT_WIDGET_CONFIGURATION,
    ...patch,
  });
}

describe("Android account-aware widget snapshots", () => {
  it("shows both Codex accounts with configured names and their own quotas by default", () => {
    const snapshot = build();
    expect(snapshot.groups.map((group) => group.name)).toEqual([
      "Codex · Personal",
      "Codex · Work",
      "Claude · Writing",
    ]);
    expect(snapshot.groups[0]?.windows.map((window) => window.remaining)).toEqual([60, 50]);
    expect(snapshot.groups[1]?.windows.map((window) => window.remaining)).toEqual([20, 10]);
    expect(snapshot.groups.every((group) => group.detail === "")).toBe(true);
  });

  it("filters accounts before calculating a combined percentage", () => {
    const selected = build({ grouping: "pooled", accountIds: ["codex:work@example.com"] });
    expect(selected.groups).toHaveLength(1);
    expect(selected.groups[0]).toMatchObject({
      name: "Codex",
      detail: "1 account · pooled",
      windows: [{ remaining: 20 }, { remaining: 10 }],
    });
    expect(build({ grouping: "pooled", providers: ["codex"] }).groups[0]).toMatchObject({
      detail: "2 accounts · pooled",
      windows: [{ remaining: 40 }, { remaining: 30 }],
    });
  });

  it("selects separate workspaces for one email and overrides only the chosen quota", () => {
    const input = presentations();
    const providers = input.get(EnvironmentId.make("laptop"))!.serverConfig.providers;
    providers.splice(
      0,
      providers.length,
      ...["personal", "business"].map((workspaceId, index) => ({
        ...provider(workspaceId, workspaceId, index * 40),
        auth: { status: "authenticated" as const, email: "same@example.com", workspaceId },
      })),
    );
    const quotas = collectSubscriptionWidgetQuotas(input, DEFAULT_WIDGET_CONFIGURATION);
    expect(new Set(quotas.map((quota) => quota.id)).size).toBe(4);
    const selected = buildAndroidSubscriptionUsageSnapshot(input, {
      ...DEFAULT_WIDGET_CONFIGURATION,
      accountIds: ["codex:same@example.com:business"],
      quotaResetDisplays: { [quotas[0]!.id]: "remaining" },
    });
    expect(selected.groups).toHaveLength(1);
    expect(selected.groups[0]).toMatchObject({
      name: "Codex · business",
      windows: [
        { remaining: 60, resetDisplay: "reset" },
        { remaining: 50, resetDisplay: "reset" },
      ],
    });
  });

  it("automatically shows names only with multiple connected environments", () => {
    const input = presentations();
    const remote = {
      entry: { target: { label: "Remote" } },
      connection: { phase: "offline" },
      serverConfig: { providers: [provider("remote", "Remote account")] },
    };
    input.set(EnvironmentId.make("remote"), remote);
    for (const phase of ["offline", "connecting", "reconnecting", "error", "available"]) {
      remote.connection.phase = phase;
      expect(
        buildAndroidSubscriptionUsageSnapshot(input, DEFAULT_WIDGET_CONFIGURATION).groups.every(
          (group) => group.detail === "",
        ),
      ).toBe(true);
    }
    remote.connection.phase = "connected";
    expect(
      buildAndroidSubscriptionUsageSnapshot(input, DEFAULT_WIDGET_CONFIGURATION).groups.map(
        (group) => group.detail,
      ),
    ).toEqual(["Laptop", "Remote", "Laptop", "Laptop"]);
    remote.connection.phase = "offline";
    expect(
      buildAndroidSubscriptionUsageSnapshot(input, DEFAULT_WIDGET_CONFIGURATION).groups.every(
        (group) => group.detail === "",
      ),
    ).toBe(true);
  });

  it("counts connected environments even when they have no quotas or are filtered out", () => {
    const input = presentations();
    input.set(EnvironmentId.make("remote"), {
      entry: { target: { label: "Remote" } },
      connection: { phase: "connected" },
      serverConfig: { providers: [] },
    });
    const snapshot = buildAndroidSubscriptionUsageSnapshot(input, {
      ...DEFAULT_WIDGET_CONFIGURATION,
      environmentIds: ["laptop"],
      accountIds: ["codex:personal@example.com"],
    });
    expect(snapshot.groups).toHaveLength(1);
    expect(snapshot.groups[0]?.detail).toBe("Laptop");
  });

  it("always shows or hides names without removing pooled counts or quota notices", () => {
    expect(
      build({ showEnvironment: true }).groups.every((group) => group.detail === "Laptop"),
    ).toBe(true);
    expect(build({ showEnvironment: false, grouping: "pooled" }).groups[0]?.detail).toBe(
      "2 accounts · pooled",
    );
    expect(build({ showEnvironment: false, codexPeriod: "monthly" }).groups[0]?.detail).toBe(
      "No monthly limit reported",
    );
    const input = presentations();
    input.set(EnvironmentId.make("remote"), {
      entry: { target: { label: "Remote" } },
      connection: { phase: "connected" },
      serverConfig: { providers: [provider("personal", "Personal remote")] },
    });
    expect(
      buildAndroidSubscriptionUsageSnapshot(input, {
        ...DEFAULT_WIDGET_CONFIGURATION,
        showEnvironment: false,
      }).groups.every((group) => group.detail === ""),
    ).toBe(true);
  });

  it("applies the same visibility choice to hub source names", () => {
    const input = new Map([
      [
        EnvironmentId.make("laptop"),
        {
          entry: { target: { label: "Laptop" } },
          connection: { phase: "connected" },
          serverConfig: {
            usageLimitSources: [
              {
                id: UsageLimitSourceId.make("hub"),
                kind: "cliproxy" as const,
                label: "Widget test",
                checkedAt,
                accounts: [
                  {
                    id: "Personal.json",
                    driver: ProviderDriverKind.make("codex"),
                    usageLimits: provider("personal", "Personal").usageLimits!,
                  },
                ],
              },
            ],
          },
        },
      ],
    ]);
    expect(
      buildAndroidSubscriptionUsageSnapshot(input, DEFAULT_WIDGET_CONFIGURATION).groups[0],
    ).toMatchObject({
      name: "Codex · Personal",
      detail: "",
    });
    expect(
      buildAndroidSubscriptionUsageSnapshot(input, {
        ...DEFAULT_WIDGET_CONFIGURATION,
        showEnvironment: true,
      }).groups[0]?.detail,
    ).toBe("Widget test");
    expect(
      buildAndroidSubscriptionUsageSnapshot(input, {
        ...DEFAULT_WIDGET_CONFIGURATION,
        showEnvironment: false,
      }).groups[0]?.detail,
    ).toBe("");
  });

  it("keeps explicit empty selections empty instead of restoring all accounts", () => {
    expect(build({ accountIds: [] })).toMatchObject({
      groups: [],
      checkedAt: 0,
      emptyMessage: "No accounts selected. Configure in T3.",
    });
    expect(build({ providers: [] }).groups).toEqual([]);
    expect(build({ environmentIds: [] }).groups).toEqual([]);
    expect(build({ accountIds: ["removed-account"] }).groups).toEqual([]);
  });

  it("selects quota periods independently for Codex and Claude", () => {
    const snapshot = build({ codexPeriod: "weekly", claudePeriod: "session" });
    expect(snapshot.groups.map((group) => group.windows.map((window) => window.label))).toEqual([
      ["Weekly"],
      ["Weekly"],
      ["Session"],
    ]);
    expect(build({ codexPeriod: "monthly" }).groups[0]).toMatchObject({
      windows: [],
      detail: "No monthly limit reported",
    });
  });

  it("chooses reset displays independently for each account's quotas", () => {
    const quotas = collectSubscriptionWidgetQuotas(presentations(), DEFAULT_WIDGET_CONFIGURATION);
    const snapshot = build({
      resetDisplay: "remaining",
      quotaResetDisplays: { [quotas[0]!.id]: "reset", [quotas[1]!.id]: "both" },
      sort: "remaining",
    });
    expect(
      snapshot.groups.find((group) => group.name === "Codex · Personal")?.windows,
    ).toMatchObject([
      { resetDisplay: "reset", resetsAt: now + 10 * 60_000 },
      { resetDisplay: "both", resetsAt: Date.parse("2026-10-15T12:00:00.000Z") },
    ]);
    expect(
      snapshot.groups
        .find((group) => group.name === "Codex · Work")
        ?.windows.every((window) => window.resetDisplay === "remaining"),
    ).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("example.com");
    expect(JSON.stringify(snapshot)).not.toContain("preferenceId");
    expect(
      build({ codexPeriod: "weekly", quotaResetDisplays: { [quotas[1]!.id]: "both" } }).groups[0]
        ?.windows[0]?.resetDisplay,
    ).toBe("both");
  });

  it("refreshes countdowns only while visible reset details and readings remain fresh", () => {
    const input = presentations();
    const original = buildSubscriptionUsageSnapshot(input, "t3code-dev://settings/usage");
    const make = (patch: Partial<SubscriptionWidgetConfiguration>) =>
      withAndroidWidgetSnapshots(original, input, {
        defaults: { ...DEFAULT_WIDGET_CONFIGURATION, ...patch },
        widgets: {},
      });
    expect(androidWidgetRefreshDeadlines(make({}), now)).toEqual([
      now + 10 * 60_000,
      now + 15 * 60_000,
    ]);
    const countdown = make({ resetDisplay: "remaining" });
    expect(androidWidgetRefreshDeadlines(countdown, now)).toEqual(
      Array.from({ length: 15 }, (_, i) => now + (i + 1) * 60_000),
    );
    expect(
      androidWidgetRefreshDeadlines(make({ resetDisplay: "both", showResetTimes: false }), now),
    ).toEqual([now + 10 * 60_000, now + 15 * 60_000]);
    expect(androidWidgetRefreshDeadlines(countdown, now + 16 * 60_000)).toEqual([]);
    expect(
      androidWidgetRefreshDeadlines(
        make({ codexPeriod: "session", providers: ["codex"], resetDisplay: "remaining" }),
        now,
      ),
    ).toEqual(Array.from({ length: 10 }, (_, i) => now + (i + 1) * 60_000));
  });

  it("selects the tightest limit and distinguishes deliberately hidden quotas", () => {
    expect(build({ codexPeriod: "tightest" }).groups[0]).toMatchObject({
      totalWindows: 1,
      windows: [{ label: "Weekly", remaining: 50 }],
    });
    expect(build({ windowsPerAccount: 1 }).groups[0]).toMatchObject({
      totalWindows: 2,
      windows: [{ label: "Session" }],
    });
    expect(build().groups[0]?.windows).toHaveLength(2);
  });

  it("stores all quota rows when scrolling is selected", () => {
    const input = presentations();
    const account = input.get(EnvironmentId.make("laptop"))!.serverConfig.providers[0]!;
    const base = account.usageLimits!.windows[0]!;
    input.get(EnvironmentId.make("laptop"))!.serverConfig.providers[0] = {
      ...account,
      usageLimits: {
        checkedAt,
        windows: Array.from({ length: 20 }, (_, index) => ({
          ...base,
          id: String(index),
          label: `Quota ${index}`,
        })),
      },
    };
    expect(
      buildAndroidSubscriptionUsageSnapshot(input, DEFAULT_WIDGET_CONFIGURATION).groups[0]?.windows,
    ).toHaveLength(20);
  });

  it("sorts accounts by their lowest remaining quota", () => {
    expect(build({ sort: "remaining" }).groups.map((group) => group.name)).toEqual([
      "Codex · Work",
      "Codex · Personal",
      "Claude · Writing",
    ]);
  });

  it("deduplicates the same account across environments and uses its freshest read", () => {
    const input = presentations();
    const remote = provider("personal", "Personal remote", 70);
    const freshRemote = {
      ...remote,
      usageLimits: { ...remote.usageLimits!, checkedAt: "2026-10-10T12:01:00.000Z" },
    };
    input.set(EnvironmentId.make("remote"), {
      entry: { target: { label: "Remote" } },
      connection: { phase: "connected" },
      serverConfig: { providers: [freshRemote] },
    });
    const snapshot = buildAndroidSubscriptionUsageSnapshot(input, {
      ...DEFAULT_WIDGET_CONFIGURATION,
      accountIds: ["codex:personal@example.com"],
    });
    expect(snapshot.groups).toHaveLength(1);
    expect(snapshot.groups[0]).toMatchObject({
      name: "Codex · Personal",
      detail: "Laptop, Remote",
      windows: [{ remaining: 30 }, { remaining: 20 }],
    });
    const filtered = buildAndroidSubscriptionUsageSnapshot(input, {
      ...DEFAULT_WIDGET_CONFIGURATION,
      accountIds: ["codex:personal@example.com"],
      environmentIds: ["remote"],
    });
    expect(filtered.groups[0]).toMatchObject({
      name: "Codex · Personal remote",
      detail: "Remote",
      windows: [{ remaining: 30 }, { remaining: 20 }],
    });
  });

  it("does not publish account emails, fingerprints, or selection identifiers to the OS", () => {
    const snapshot = build({ accountIds: ["codex:work@example.com"] });
    expect(JSON.stringify(snapshot)).not.toContain("example.com");
    expect(JSON.stringify(snapshot)).not.toContain("credential-");
    expect(JSON.stringify(snapshot)).not.toContain("accountIds");
    expect(snapshot.groups[0]?.name).toBe("Codex · Work");
  });

  it("expires each quota independently instead of expiring Weekly at the Session reset", () => {
    expect(build().groups[0]?.windows.map((window) => window.expiresAt)).toEqual([
      now + 10 * 60_000,
      now + 15 * 60_000,
    ]);
    expect(build({ codexPeriod: "weekly" }).groups[0]?.windows[0]?.expiresAt).toBe(
      now + 15 * 60_000,
    );
  });

  it("never presents malformed observation times as fresh", () => {
    const input = presentations();
    const providers = input.get(EnvironmentId.make("laptop"))!.serverConfig.providers;
    providers[0] = {
      ...providers[0]!,
      usageLimits: { ...providers[0]!.usageLimits!, checkedAt: "invalid" },
    };
    const snapshot = buildAndroidSubscriptionUsageSnapshot(input, DEFAULT_WIDGET_CONFIGURATION);
    expect(snapshot.checkedAt).toBe(0);
    expect(snapshot.groups[0]?.windows.every((window) => window.expiresAt === 0)).toBe(true);
  });

  it("keeps two widget profiles independent while preserving the iOS snapshot", () => {
    const input = presentations();
    const original = buildSubscriptionUsageSnapshot(input, "t3code-dev://settings/usage");
    const snapshot = withAndroidWidgetSnapshots(original, input, {
      defaults: DEFAULT_WIDGET_CONFIGURATION,
      widgets: {
        "12": {
          ...DEFAULT_WIDGET_CONFIGURATION,
          accountIds: ["codex:personal@example.com"],
          showEnvironment: true,
        },
        "13": {
          ...DEFAULT_WIDGET_CONFIGURATION,
          providers: ["claudeAgent"],
          showBars: false,
          theme: "light",
          showEnvironment: false,
        },
      },
    });
    expect(snapshot.providers).toEqual(original.providers);
    expect(snapshot.android?.defaults.groups).toHaveLength(3);
    expect(snapshot.android?.defaults.groups[0]?.detail).toBe("");
    expect(snapshot.android?.widgets["12"]?.groups[0]?.detail).toBe("Laptop");
    expect(snapshot.android?.widgets["13"]?.groups[0]?.detail).toBe("");
    expect(snapshot.android?.widgets["12"]?.groups.map((group) => group.name)).toEqual([
      "Codex · Personal",
    ]);
    expect(snapshot.android?.widgets["13"]?.groups.map((group) => group.name)).toEqual([
      "Claude · Writing",
    ]);
    expect(snapshot.android?.widgets["13"]?.configuration).toMatchObject({
      showBars: false,
      theme: "light",
    });
  });
});

describe("widget preference selection", () => {
  it("distinguishes all future accounts from an explicit selection and supports deselecting the last one", () => {
    expect(toggleWidgetSelection(null, ["a", "b"], "a")).toEqual(["b"]);
    expect(toggleWidgetSelection(["b"], ["a", "b"], "b")).toEqual([]);
    expect(toggleWidgetSelection([], ["a", "b"], "a")).toEqual(["a"]);
  });

  it("retains valid per-widget profiles and resets malformed saved settings", () => {
    const preferences = {
      defaults: DEFAULT_WIDGET_CONFIGURATION,
      widgets: { "12": { ...DEFAULT_WIDGET_CONFIGURATION, density: "compact" as const } },
    };
    expect(resolveWidgetPreferences(preferences)).toEqual(preferences);
    expect(
      resolveWidgetPreferences({
        ...preferences,
        defaults: { ...preferences.defaults, theme: "broken" },
      }),
    ).toEqual({ defaults: DEFAULT_WIDGET_CONFIGURATION, widgets: {} });
  });

  it("upgrades saved widget configurations without resetting their existing choices", () => {
    const {
      resetDisplay: _resetDisplay,
      quotaResetDisplays: _quotaResetDisplays,
      ...legacy
    } = DEFAULT_WIDGET_CONFIGURATION;
    const upgraded = resolveWidgetPreferences({
      defaults: { ...legacy, theme: "dark", showEnvironment: true },
      widgets: {
        "12": {
          ...legacy,
          windowsPerAccount: 1,
          accountIds: ["codex:work@example.com"],
          showEnvironment: false,
        },
      },
    });
    expect(upgraded.defaults).toMatchObject({
      theme: "dark",
      resetDisplay: "reset",
      quotaResetDisplays: {},
      showEnvironment: true,
    });
    expect(upgraded.widgets["12"]).toMatchObject({
      windowsPerAccount: 1,
      accountIds: ["codex:work@example.com"],
      resetDisplay: "reset",
      quotaResetDisplays: {},
      showEnvironment: false,
    });
  });

  it("defaults to automatic visibility when no saved choice exists", () => {
    const { showEnvironment: _showEnvironment, ...configuration } = DEFAULT_WIDGET_CONFIGURATION;
    const preferences = resolveWidgetPreferences({
      defaults: { ...configuration, theme: "dark" },
      widgets: { "12": { ...configuration, density: "compact" } },
    });
    expect(preferences.defaults).toMatchObject({ theme: "dark", showEnvironment: "auto" });
    expect(preferences.widgets["12"]).toMatchObject({
      density: "compact",
      showEnvironment: "auto",
    });
  });
});
