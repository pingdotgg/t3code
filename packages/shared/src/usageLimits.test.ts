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
  collectLimitSources,
  collectLimitsGroups,
  elapsedShare,
  formatResetsIn,
  limitsNotice,
  paceOf,
  providersWithLimits,
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
