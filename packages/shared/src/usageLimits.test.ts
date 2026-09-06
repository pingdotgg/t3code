import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type UsageLimitSourceAccount,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isUsageLimitsCommand,
  collectProviderUsageLimits,
  sameUsageLimitCommandCoverage,
  withUsageLimitsCommands,
  collectLimitSources,
  collectLimitsGroups,
  elapsedShare,
  formatResetsIn,
  limitsNotice,
  paceOf,
  providersWithLimits,
  remainingPercent,
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

describe("pace", () => {
  it("places the clock three fifths through a five-hour window with two hours left", () => {
    expect(elapsedShare(window, now)).toBeCloseTo(0.6);
    expect(paceOf(window, now)).toBe("under");
    expect(paceOf({ ...window, usedPercent: 62 }, now)).toBe("on");
    expect(paceOf({ ...window, usedPercent: 80 }, now)).toBe("ahead");
  });

  it("has no pace without a reset or a duration", () => {
    expect(paceOf({ ...window, resetsAt: undefined }, now)).toBeNull();
    expect(paceOf({ ...window, windowDurationMins: undefined }, now)).toBeNull();
    expect(formatResetsIn({ ...window, resetsAt: undefined }, now)).toBeNull();
  });

  it("phrases the reset as a countdown", () => {
    expect(formatResetsIn(window, now)).toBe("resets in 2h 0m");
    expect(formatResetsIn({ ...window, resetsAt: "2026-09-06T15:30:00.000Z" }, now)).toBe(
      "resets in 3d 3h",
    );
    expect(formatResetsIn({ ...window, resetsAt: "2026-09-03T11:00:00.000Z" }, now)).toBe(
      "resets now",
    );
  });
});

describe("limitsNotice", () => {
  it("explains empty bars and passes provider messages through", () => {
    const checkedAt = "2026-09-03T11:00:00.000Z";
    expect(limitsNotice({ checkedAt, windows: [window] })).toBeNull();
    expect(limitsNotice({ checkedAt, windows: [] })).toBe("No limits reported.");
    expect(limitsNotice({ checkedAt, windows: [], unavailable: { reason: "unsupported" } })).toBe(
      "This account has no subscription limits.",
    );
    expect(
      limitsNotice({
        checkedAt,
        windows: [],
        unavailable: { reason: "probeFailed", message: "Codex timed out." },
      }),
    ).toBe("Codex timed out.");
  });
});

describe("providersWithLimits", () => {
  it("keeps only usable providers whose driver reports limits at all", () => {
    const limits = { checkedAt: "2026-09-03T11:00:00.000Z", windows: [window] };
    const codex = provider({ usageLimits: limits });
    expect(
      providersWithLimits([
        codex,
        provider({
          instanceId: ProviderInstanceId.make("cursor"),
          driver: ProviderDriverKind.make("cursor"),
        }),
        provider({
          instanceId: ProviderInstanceId.make("off"),
          enabled: false,
          usageLimits: limits,
        }),
        provider({
          instanceId: ProviderInstanceId.make("gone"),
          installed: false,
          usageLimits: limits,
        }),
        provider({
          instanceId: ProviderInstanceId.make("shadow"),
          availability: "unavailable",
          usageLimits: limits,
        }),
      ]),
    ).toEqual([codex]);
  });
});

describe("collectLimitsGroups", () => {
  it("labels environments only when more than one reports limits", () => {
    const limits = { checkedAt: "2026-09-03T11:00:00.000Z", windows: [window] };
    const codex = provider({ usageLimits: limits });
    const one = new Map([
      ["env-a", { entry: { target: { label: "Laptop" } }, serverConfig: { providers: [codex] } }],
      [
        "env-b",
        { entry: { target: { label: "Desktop" } }, serverConfig: { providers: [provider({})] } },
      ],
    ] as const);
    expect(collectLimitsGroups(one as never).map((group) => group.environmentLabel)).toEqual([
      null,
    ]);

    const two = new Map([
      ["env-a", { entry: { target: { label: "Laptop" } }, serverConfig: { providers: [codex] } }],
      ["env-b", { entry: { target: { label: "Desktop" } }, serverConfig: { providers: [codex] } }],
    ] as const);
    expect(collectLimitsGroups(two as never).map((group) => group.environmentLabel)).toEqual([
      "Laptop",
      "Desktop",
    ]);
  });
});

describe("collectLimitSources", () => {
  const source = {
    id: UsageLimitSourceId.make("cliproxy-hub"),
    kind: "cliproxy" as const,
    label: "hub",
    checkedAt: "2026-09-03T11:00:00.000Z",
    accounts: [],
  };
  const limits = { checkedAt: source.checkedAt, windows: [window] };
  const account: UsageLimitSourceAccount = {
    id: "codex-personal",
    driver: ProviderDriverKind.make("codex"),
    email: "person@example.com",
    plan: "ChatGPT Pro Subscription",
    usageLimits: limits,
  };
  const native = provider({
    displayName: "Personal",
    auth: { status: "authenticated", email: account.email },
    usageLimits: { ...limits, resetCredits: { availableCount: 2 } },
  });

  function presentations(
    providers: readonly ServerProvider[],
    accounts: readonly UsageLimitSourceAccount[] = [account],
  ) {
    return new Map([
      [
        EnvironmentId.make("env-a"),
        {
          entry: { target: { label: "Laptop" } },
          serverConfig: { providers, usageLimitSources: [{ ...source, accounts }] },
        },
      ],
    ]);
  }

  it.each(["codex", "claudeAgent"])(
    "prefers native %s limits by email without changing provider rows or source snapshots",
    (kind) => {
      const driver = ProviderDriverKind.make(kind);
      const first = { ...native, driver };
      const second = { ...first, instanceId: ProviderInstanceId.make("work") };
      const accounts = [{ ...account, driver, email: " Person@Example.COM " }];
      const input = presentations([first, second], accounts);

      expect(collectLimitSources(input)).toMatchObject([{ accounts: [], hiddenAccountCount: 1 }]);
      expect(collectLimitsGroups(input)[0]?.providers).toEqual([first, second]);
      expect(accounts).toHaveLength(1);
      expect(first.usageLimits?.resetCredits?.availableCount).toBe(2);
    },
  );

  it("matches across environments even when the hub is visited before the native provider", () => {
    const input = presentations([]);
    input.set(EnvironmentId.make("env-b"), {
      entry: { target: { label: "Desktop" } },
      serverConfig: { providers: [native], usageLimitSources: [] },
    });

    expect(collectLimitSources(input)).toMatchObject([
      { accounts: [], hiddenAccountCount: 1, environmentId: "env-a" },
    ]);
  });

  it("keeps other providers, other emails, and unidentified accounts with the same plan", () => {
    const accounts = [
      account,
      { ...account, id: "other-provider", driver: ProviderDriverKind.make("claudeAgent") },
      { ...account, id: "other-email", email: "other@example.com" },
      { ...account, id: "unknown-email", email: undefined },
    ];

    expect(collectLimitSources(presentations([native], accounts))).toMatchObject([
      { accounts: accounts.slice(1), hiddenAccountCount: 1 },
    ]);
    expect(
      collectLimitSources(
        presentations([{ ...native, auth: { status: "authenticated" } }], accounts),
      )[0]?.accounts,
    ).toEqual(accounts);
  });

  it.each([
    { enabled: false },
    { installed: false },
    { availability: "unavailable" },
    { usageLimits: undefined },
    { usageLimits: { ...limits, windows: [] } },
    { usageLimits: { ...limits, unavailable: { reason: "probeFailed" } } },
    { usageLimits: { ...limits, unavailable: { reason: "unsupported" } } },
  ] satisfies Partial<ServerProvider>[])(
    "retains hub limits when the native provider cannot show them: %j",
    (overrides) => {
      expect(collectLimitSources(presentations([{ ...native, ...overrides }]))).toMatchObject([
        { accounts: [account], hiddenAccountCount: 0 },
      ]);
    },
  );

  it("restores the hub account when the matching provider disappears", () => {
    const input = presentations([native]);
    expect(collectLimitSources(input)[0]?.accounts).toEqual([]);
    input.delete(EnvironmentId.make("env-a"));
    for (const [id, entry] of presentations([])) input.set(id, entry);

    expect(collectLimitSources(input)[0]?.accounts).toEqual([account]);
  });

  it("keeps source errors and genuinely empty sources distinguishable from hidden accounts", () => {
    const input = new Map([
      [
        EnvironmentId.make("env-a"),
        {
          entry: { target: { label: "Laptop" } },
          serverConfig: {
            providers: [native],
            usageLimitSources: [{ ...source, error: "Hub unavailable" }],
          },
        },
      ],
    ]);
    expect(collectLimitSources(input)).toMatchObject([
      { accounts: [], hiddenAccountCount: 0, error: "Hub unavailable" },
    ]);
  });

  it("keys sources per environment and names the environment only when several have some", () => {
    const one = new Map([
      [
        "env-a",
        { entry: { target: { label: "Laptop" } }, serverConfig: { usageLimitSources: [source] } },
      ],
      [
        "env-b",
        { entry: { target: { label: "Desktop" } }, serverConfig: { usageLimitSources: [] } },
      ],
    ] as const);
    expect(collectLimitSources(one as never).map((entry) => [entry.key, entry.label])).toEqual([
      ["env-a:cliproxy-hub", "hub"],
    ]);

    const two = new Map([
      [
        "env-a",
        { entry: { target: { label: "Laptop" } }, serverConfig: { usageLimitSources: [source] } },
      ],
      [
        "env-b",
        { entry: { target: { label: "Desktop" } }, serverConfig: { usageLimitSources: [source] } },
      ],
    ] as const);
    expect(collectLimitSources(two as never).map((entry) => entry.label)).toEqual([
      "Laptop · hub",
      "Desktop · hub",
    ]);
  });
});

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

  it("keeps accounts and custom instances separate, filtering by driver", () => {
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
    // A read failure clears the accounts, so the error must not depend on a match.
    const unreadable = { ...failing, accounts: [] };
    expect(
      collectProviderUsageLimits(selected.instanceId, [selected], [unreadable], now)?.notices,
    ).toEqual(["Accounts: token expired"]);
    // A source-only provider still gets the report, carrying only the error.
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
    // A provider's own command of the same name is left alone without coverage.
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

describe("sameUsageLimitCommandCoverage", () => {
  const codexAccount = {
    id: "a",
    driver: ProviderDriverKind.make("codex"),
    usageLimits: { checkedAt: "2026-09-03T11:00:00.000Z", windows: [] },
  };
  const base = {
    id: UsageLimitSourceId.make("hub"),
    kind: "cliproxy" as const,
    label: "Accounts",
    checkedAt: "2026-09-03T11:00:00.000Z",
  };
  it("ignores quota movement but not the drivers offered the command", () => {
    const withCodex = [{ ...base, accounts: [codexAccount] }];
    const withCodexLater = [
      {
        ...base,
        accounts: [
          {
            ...codexAccount,
            usageLimits: { ...codexAccount.usageLimits, checkedAt: "2026-09-03T12:00:00.000Z" },
          },
        ],
      },
    ];
    expect(sameUsageLimitCommandCoverage(withCodex, withCodexLater)).toBe(true);
    expect(sameUsageLimitCommandCoverage(withCodex, [{ ...base, accounts: [] }])).toBe(false);
  });
  it("treats a failed read as a change in coverage, in both directions", () => {
    const empty = [{ ...base, accounts: [] }];
    const failed = [{ ...base, accounts: [], error: "token expired" }];
    expect(sameUsageLimitCommandCoverage(empty, failed)).toBe(false);
    expect(sameUsageLimitCommandCoverage(failed, empty)).toBe(false);
    expect(
      sameUsageLimitCommandCoverage(failed, [{ ...base, accounts: [], error: "still down" }]),
    ).toBe(true);
  });
});

describe("remainingPercent", () => {
  it("inverts and clamps the reported usage", () => {
    expect(remainingPercent(window)).toBe(60);
    expect(remainingPercent({ ...window, usedPercent: 0 })).toBe(100);
    expect(remainingPercent({ ...window, usedPercent: 100 })).toBe(0);
    expect(remainingPercent({ ...window, usedPercent: 33.4 })).toBe(67);
  });
});

describe("isUsageLimitsCommand", () => {
  it("recognizes only the standalone local action", () => {
    expect(isUsageLimitsCommand("  /USAGE-LIMITS\n")).toBe(true);
    expect(isUsageLimitsCommand("/usage-limits explain")).toBe(false);
    expect(isUsageLimitsCommand("Explain /usage-limits")).toBe(false);
    expect(isUsageLimitsCommand("/usage")).toBe(false);
  });
});
