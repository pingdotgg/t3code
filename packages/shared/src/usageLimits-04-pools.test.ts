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










describe("pools", () => {
  const checkedAt = "2026-09-03T11:00:00.000Z";
  const weekly = {
    id: "seven_day",
    kind: "weekly",
    label: "Weekly",
    windowDurationMins: 7 * 24 * 60,
    resetsAt: "2026-09-06T12:00:00.000Z",
  } as const;
  const claude = ProviderDriverKind.make("claudeAgent");
  const source = {
    id: UsageLimitSourceId.make("hub"),
    kind: "cliproxy" as const,
    label: "hub",
    checkedAt,
  };
  const laptop = { entry: { target: { label: "Laptop" } } };

  it("pools Codex windows by kind, whichever slot reported them", () => {
    const codexAccount = (id: string, slots: readonly string[]) => ({
      id,
      driver: ProviderDriverKind.make("codex"),
      usageLimits: {
        checkedAt,
        windows: slots.map((slot) => ({ ...weekly, id: slot, usedPercent: 50 })),
      },
    });
    const pooled = (accounts: ReturnType<typeof codexAccount>[]) =>
      collectLimitPools(
        collectLimitAccounts(
          new Map([
            [
              EnvironmentId.make("env-a"),
              {
                ...laptop,
                serverConfig: { providers: [], usageLimitSources: [{ ...source, accounts }] },
              },
            ],
          ]),
        ),
        now,
      )[0]?.windows ?? [];
    for (const order of [
      [codexAccount("business", ["primary"]), codexAccount("plus", ["secondary"])],
      [codexAccount("plus", ["secondary"]), codexAccount("business", ["primary"])],
    ]) {
      const windows = pooled(order);
      expect(windows.map((window) => window.id)).toEqual(["weekly"]);
      expect(windows[0]?.members).toHaveLength(2);
    }
    expect(
      pooled([codexAccount("a", ["secondary"]), codexAccount("b", ["primary", "secondary"])]).map(
        (window) => window.id,
      ),
    ).toEqual(["weekly", "weekly:secondary"]);
  });
  it("pools windows by id across accounts and orders resets by when they land", () => {
    const input = new Map([
      [
        EnvironmentId.make("env-a"),
        {
          ...laptop,
          serverConfig: {
            providers: [],
            usageLimitSources: [
              {
                ...source,
                accounts: [
                  {
                    id: "a",
                    driver: claude,
                    usageLimits: {
                      checkedAt,
                      windows: [
                        { ...window, usedPercent: 80, resetsAt: "2026-09-03T13:00:00.000Z" },
                        { ...weekly, usedPercent: 20 },
                      ],
                    },
                  },
                  {
                    id: "b",
                    driver: claude,
                    usageLimits: {
                      checkedAt,
                      windows: [{ ...window, usedPercent: 40 }],
                    },
                  },
                  {
                    id: "c",
                    driver: ProviderDriverKind.make("codex"),
                    usageLimits: { checkedAt, windows: [{ ...weekly, usedPercent: 50 }] },
                  },
                  {
                    id: "unsupported",
                    driver: claude,
                    usageLimits: {
                      checkedAt,
                      windows: [],
                      unavailable: { reason: "unsupported" as const },
                    },
                  },
                ],
              },
            ],
          },
        },
      ],
    ]);
    const pools = collectLimitPools(collectLimitAccounts(input), now);
    expect(pools.map((pool) => [pool.driver, pool.accounts.length])).toEqual([
      ["claudeAgent", 2],
      ["codex", 1],
    ]);
    const [session, week] = pools[0]!.windows;
    const untimed = collectLimitPools(
      collectLimitAccounts(input).map((account) =>
        account.key === "hub:b"
          ? {
              ...account,
              limits: {
                ...account.limits,
                windows: account.limits.windows.map((w) => ({ ...w, resetsAt: undefined })),
              },
            }
          : account,
      ),
      now,
    );
    expect(untimed[0]?.windows[0]?.pace).toBe("on");
    expect(session).toMatchObject({
      id: "five_hour",
      remainingPercent: 40,
      usedPercent: 60,
      pace: "under",
    });
    expect(
      session?.resets.map((reset) => [reset.member.account.key, reset.restoresPercent]),
    ).toEqual([
      ["hub:a", 40],
      ["hub:b", 20],
    ]);
    expect(week).toMatchObject({ id: "seven_day", remainingPercent: 80, members: [{}] });
    // Codex reports `primary` for both its five-hour and (on Go) monthly window.
    const mixed = collectLimitPools(
      [
        ...collectLimitAccounts(input),
        {
          key: "go",
          driver: claude,
          displayName: "Go",
          email: undefined,
          plan: undefined,
          accentColor: undefined,
          environments: [],
          sourceLabel: null,
          redeem: null,
          limits: {
            checkedAt,
            windows: [
              {
                id: "five_hour",
                kind: "monthly",
                label: "Monthly",
                usedPercent: 82,
                windowDurationMins: 30 * 24 * 60,
                resetsAt: "2026-09-14T12:00:00.000Z",
              },
            ],
          },
        },
      ],
      now,
    );
    expect(mixed[0]?.windows.map((window) => [window.kind, window.members.length])).toEqual([
      ["session", 2],
      ["weekly", 1],
      ["monthly", 1],
    ]);
    expect(session?.members.map((member) => member.account.key)).toEqual(["hub:a", "hub:b"]);
    expect(pools[0]?.accounts.map((account) => account.key)).toEqual(["hub:a", "hub:b"]);
  });
});

