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










describe("pooled account columns", () => {
  const weekly = {
    ...window,
    id: "seven_day",
    kind: "weekly",
    label: "Weekly",
    windowDurationMins: 7 * 24 * 60,
  } as const;
  const account = (key: string, windows: LimitAccount["limits"]["windows"]): LimitAccount => ({
    key,
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: key,
    email: undefined,
    plan: undefined,
    accentColor: undefined,
    environments: [],
    sourceLabel: "Hub",
    redeem: null,
    limits: { checkedAt: "2026-09-03T11:00:00.000Z", windows },
  });
  const keys = (pool: ReturnType<typeof collectLimitPools>[number]) =>
    pool.windows.map((row) =>
      row.columns.map((member) => (member.window ? member.account.key : null)),
    );

  // regression: #20349 sessions stay visible while the weekly quota is exhausted
  it.each([
    ["claudeAgent", "13:00", 40, "14:00", 100],
    ["codex", "14:00", 100, "14:00", 100],
    ["claudeAgent", "15:00", 100, "15:00", 100],
    ["codex", "15:00", 40, "14:00", 60],
  ] as const)(
    "%s session resetting at %s with %i percent spent becomes usable at %s with %i percent restored",
    (driver, sessionReset, usedPercent, usableAt, restoresPercent) => {
      const at = (time: string) => `2026-09-03T${time}:00.000Z`;
      const a = {
        ...account("a", [
          {
            ...window,
            id: driver === "codex" ? "primary" : window.id,
            usedPercent,
            resetsAt: at(sessionReset),
          },
          {
            ...weekly,
            id: driver === "codex" ? "secondary" : weekly.id,
            usedPercent: 100,
            resetsAt: at("14:00"),
          },
        ]),
        driver: ProviderDriverKind.make(driver),
      };
      const [session] = collectLimitPools([a], now)[0]!.windows;
      expect.soft(session?.remainingPercent).toBe(0);
      expect(session?.resets[0]).toMatchObject({
        at: Date.parse(at(usableAt)),
        restoresPercent,
      });
    },
  );

  it("excludes weekly-blocked sessions from the pool without changing snapshots or model allowances", () => {
    const blocked = account("blocked", [
      window,
      { ...weekly, usedPercent: 100 },
      { ...weekly, id: "seven_day_fable", usedPercent: 20 },
    ]);
    const accounts = [
      blocked,
      account("available", [
        { ...window, usedPercent: 20 },
        { ...weekly, usedPercent: 99 },
        { ...weekly, id: "seven_day_fable", usedPercent: 40 },
      ]),
      { ...blocked, key: "cursor", driver: ProviderDriverKind.make("cursor") },
    ];
    const snapshot = structuredClone(accounts);
    const [claude, cursor] = collectLimitPools(accounts, now);
    expect.soft(claude?.windows.map((row) => row.remainingPercent)).toEqual([40, 1, 70]);
    expect.soft(cursor?.windows.map((row) => row.remainingPercent)).toEqual([60, 0, 80]);
    expect(accounts).toEqual(snapshot);
  });

  it("keeps session columns across rows with opposite reset and usage orders", () => {
    const accounts = [
      account("a", [
        { ...weekly, usedPercent: 80, resetsAt: "2026-09-05T12:00:00.000Z" },
        { ...window, usedPercent: 10, resetsAt: "2026-09-03T15:00:00.000Z" },
      ]),
      account("b", [
        { ...weekly, usedPercent: 20, resetsAt: "2026-09-06T12:00:00.000Z" },
        { ...window, usedPercent: 90, resetsAt: "2026-09-03T13:00:00.000Z" },
      ]),
    ];
    const [pool] = collectLimitPools(accounts, now);
    expect(pool!.accounts.map((account) => account.key)).toEqual(["b", "a"]);
    expect(keys(pool!)).toEqual([
      ["b", "a"],
      ["b", "a"],
    ]);
    expect(pool!.windows[1]!.resets.map((reset) => reset.member.account.key)).toEqual(["a", "b"]);
    expect(pool!.windows[1]!.remainingPercent).toBe(50);
    expect(keys(collectLimitPools(accounts.toReversed(), now)[0]!)).toEqual(keys(pool!));
  });

  it.each([undefined, "invalid", "2026-09-03T11:30:00.000Z"])(
    "keeps blocked sessions empty without predicting a refill from a missing or stale clock (%s)",
    (resetsAt) => {
      const [pool] = collectLimitPools(
        [
          account("session-clock", [
            { ...window, resetsAt },
            { ...weekly, usedPercent: 100 },
          ]),
          account("weekly-clock", [window, { ...weekly, usedPercent: 100, resetsAt }]),
        ],
        now,
      );
      expect(pool!.windows[0]).toMatchObject({ remainingPercent: 0, pace: null, resets: [] });
      expect(pool!.windows[0]!.columns.map((column) => column.window?.resetsAt)).toEqual([
        undefined,
        undefined,
      ]);
    },
  );

  it("orders by usable session refill and clears suppression after a fresh weekly reading", () => {
    const blocked = account("blocked", [
      { ...window, resetsAt: "2026-09-03T13:00:00.000Z" },
      { ...weekly, usedPercent: 100, resetsAt: "2026-09-03T15:00:00.000Z" },
    ]);
    const available = account("available", [window]);
    const [before] = collectLimitPools([blocked, available], now);
    expect(before!.accounts.map((account) => account.key)).toEqual(["available", "blocked"]);
    expect(before!.windows[0]!.remainingPercent).toBe(30);
    const refreshed = {
      ...blocked,
      limits: {
        checkedAt: "2026-09-03T12:00:00.000Z",
        windows: [blocked.limits.windows[0]!, { ...weekly, usedPercent: 10 }],
      },
    };
    const [after] = collectLimitPools([refreshed, available], now);
    expect(after!.accounts.map((account) => account.key)).toEqual(["blocked", "available"]);
    expect(after!.windows[0]!.remainingPercent).toBe(60);
    expect(after!.windows[0]!.resets[0]).toMatchObject({
      at: Date.parse("2026-09-03T13:00:00.000Z"),
      restoresPercent: 20,
    });
  });

  it("preserves gaps without counting missing windows toward pooled quota", () => {
    const [pool] = collectLimitPools(
      [
        account("a", [window]),
        account("b", [
          { ...window, resetsAt: "2026-09-03T15:00:00.000Z" },
          { ...weekly, usedPercent: 80 },
        ]),
        account("c", [weekly]),
      ],
      now,
    );
    expect(keys(pool!)).toEqual([
      ["a", "b", null],
      [null, "b", "c"],
    ]);
    expect(pool!.windows[1]!.members.map((member) => member.account.key)).toEqual(["b", "c"]);
    expect(pool!.windows[1]!.remainingPercent).toBe(40);
    expect(pool!.windows[1]!.resets.map((reset) => reset.restoresPercent)).toEqual([40, 20]);
  });

  it("falls back to weekly resets when no account reports a session", () => {
    const [pool] = collectLimitPools(
      [
        account("a", [{ ...weekly, resetsAt: "2026-09-06T12:00:00.000Z" }]),
        account("b", [{ ...weekly, resetsAt: "2026-09-05T12:00:00.000Z" }]),
      ],
      now,
    );
    expect(keys(pool!)).toEqual([["b", "a"]]);
  });
});

