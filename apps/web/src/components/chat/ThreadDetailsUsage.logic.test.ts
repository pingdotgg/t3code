import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type UsageLimitSourceSnapshot,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  foldLimitRows,
  groupLimitRows,
  isWideLimitLabel,
  limitTone,
  poolSources,
  resolveThreadDetailsLimits,
  resolveThreadHttpQuotas,
} from "./ThreadDetailsUsage.logic";

const now = Date.parse("2026-10-30T12:00:00.000Z");
const checkedAt = "2026-10-30T11:59:00.000Z";
const claude = ProviderDriverKind.make("claudeAgent");
const codex = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("claudeAgent");

function limitsAt(usedPercent: number): ServerProviderUsageLimits {
  return {
    checkedAt,
    windows: [
      {
        id: "five_hour",
        kind: "session",
        label: "Session",
        usedPercent,
        windowDurationMins: 300,
        resetsAt: "2026-10-30T13:17:00.000Z",
      },
    ],
  };
}

const unsupported: ServerProviderUsageLimits = {
  checkedAt,
  windows: [],
  unavailable: { reason: "unsupported" },
};

function claudeInstance(usageLimits: ServerProviderUsageLimits): ServerProvider {
  return {
    instanceId,
    driver: claude,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: {
      status: "authenticated",
      type: "customEndpoint",
      label: "Custom API endpoint",
      endpoint: "http://127.0.0.1:8317",
    },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits,
  };
}

interface HubAccountInput {
  readonly id: string;
  readonly driver?: ProviderDriverKind;
  readonly models?: readonly string[];
  readonly limits: ServerProviderUsageLimits;
}

function hub(
  label: string,
  accounts: readonly HubAccountInput[],
  origin = "http://127.0.0.1:8317",
): UsageLimitSourceSnapshot {
  return {
    id: UsageLimitSourceId.make(label),
    kind: "cliproxy",
    label,
    origin,
    checkedAt,
    accounts: accounts.map((account) => ({
      id: account.id,
      driver: account.driver ?? claude,
      ...(account.models ? { models: account.models } : {}),
      usageLimits: account.limits,
    })),
  };
}

function shown(
  own: ServerProviderUsageLimits,
  sources: readonly UsageLimitSourceSnapshot[],
  model: string | null,
) {
  const resolved = resolveThreadDetailsLimits(
    instanceId,
    model,
    [claudeInstance(own)],
    sources,
    now,
  );
  if (resolved?.kind !== "pool") return resolved;
  return {
    kind: resolved.kind,
    rows: resolved.windows.map((window) => ({
      label: window.label,
      left: window.remainingPercent,
      accounts: window.members.length,
      from: poolSources(window),
    })),
  };
}

describe("resolveThreadDetailsLimits", () => {
  it("keeps an instance's failed reading instead of a hub it is not sent to", () => {
    const failed: ServerProviderUsageLimits = {
      checkedAt,
      windows: [],
      unavailable: { reason: "probeFailed" },
    };
    const direct = { ...claudeInstance(failed), auth: { status: "authenticated" as const } };
    const elsewhere = claudeInstance(unsupported);
    const readableHub = hub("Hub", [{ id: "a.json", limits: limitsAt(20) }]);
    const otherHub = hub("Other", [{ id: "a.json", limits: limitsAt(20) }], "http://hub");
    expect(resolveThreadDetailsLimits(instanceId, null, [direct], [readableHub], now)).toEqual({
      kind: "instance",
      limits: failed,
    });
    expect(resolveThreadDetailsLimits(instanceId, null, [elsewhere], [otherHub], now)).toEqual({
      kind: "instance",
      limits: unsupported,
    });
  });

  it("pools only the accounts the hub routes the model to, even of another driver", () => {
    const sources = [
      hub("Hub", [
        { id: "a.json", models: ["claude-opus-5-5"], limits: limitsAt(10) },
        { id: "c.json", driver: codex, models: ["gpt-5.6-sol"], limits: limitsAt(30) },
      ]),
    ];
    expect(shown(unsupported, sources, "gpt-5.6-sol[1m]")).toEqual({
      kind: "pool",
      rows: [{ label: "Session", left: 70, accounts: 1, from: { hubs: ["Hub"], signedIn: false } }],
    });
  });
});

describe("foldLimitRows", () => {
  const row = (
    id: string,
    kind: "session" | "weekly",
    usedPercent: number,
    driver: ProviderDriverKind = claude,
  ) => ({ driver, window: { id, kind, label: id, usedPercent } });
  const ids = (rows: ReadonlyArray<{ readonly window: { readonly id: string } }>) =>
    rows.map((entry) => entry.window.id);

  it("shows the nearest per period when no model is selected, and never hides a low one", () => {
    const rows = [
      row("five_hour_a", "session", 0),
      row("five_hour_b", "session", 17),
      row("seven_day_a", "weekly", 0),
      row("seven_day_b", "weekly", 6),
    ];
    expect(ids(foldLimitRows(rows, null).shown)).toEqual(["five_hour_b", "seven_day_b"]);
    const spent = [...rows.slice(0, 3), row("seven_day_b", "weekly", 100)];
    expect(ids(foldLimitRows(spent, null).shown)).toEqual(["five_hour_b", "seven_day_b"]);
    const lowExtra = [
      row("five_hour_a", "session", 100),
      row("five_hour_b", "session", 90),
      row("seven_day_a", "weekly", 0),
      row("seven_day_b", "weekly", 6),
    ];
    expect(ids(foldLimitRows(lowExtra, null).shown)).toEqual([
      "five_hour_a",
      "five_hour_b",
      "seven_day_b",
    ]);
  });

  it("folds a Claude weekly limit scoped to another model", () => {
    const rows = [
      row("five_hour", "session", 40, claude),
      row("seven_day", "weekly", 30, claude),
      row("seven_day_opus", "weekly", 50, claude),
      row("seven_day_sonnet", "weekly", 10, claude),
    ];
    expect(ids(foldLimitRows(rows, "claude-opus-5-5").hidden)).toEqual(["seven_day_sonnet"]);
    expect(foldLimitRows(rows.slice(0, 2), "claude-opus-5-5").hidden).toEqual([]);
    expect(foldLimitRows(rows.slice(0, 3), "claude-opus-5-5").hidden).toEqual([]);
  });

  it("never folds a window projected to run out before it resets", () => {
    const rows = [
      row("five_hour", "session", 40, claude),
      row("seven_day", "weekly", 30, claude),
      { ...row("seven_day_sonnet", "weekly", 70, claude), runsOutBeforeReset: true },
    ];
    expect(ids(foldLimitRows(rows, "claude-opus-5-5").shown)).toEqual([
      "five_hour",
      "seven_day",
      "seven_day_sonnet",
    ]);
  });
});

describe("limitTone", () => {
  it("flags low limits and limits projected to run out before reset", () => {
    expect(limitTone(50)).toBeNull();
    expect(limitTone(20)).toBe("warning");
    expect(limitTone(10)).toBe("error");
    expect(limitTone(30, true)).toBe("warning");
    expect(limitTone(10, true)).toBe("error");
  });
});

describe("groupLimitRows", () => {
  const antigravity = ProviderDriverKind.make("antigravity");
  const row = (
    id: string,
    usedPercent: number,
    driver: ProviderDriverKind,
    runsOutBeforeReset = false,
  ) => ({
    driver,
    runsOutBeforeReset,
    window: { id, kind: "session" as const, label: id, usedPercent },
  });

  it("groups by provider and orders both groups and windows tightest first", () => {
    const rows = [
      row("3p-weekly", 12, antigravity),
      row("3p-5h", 36, antigravity),
      row("five_hour", 42, claude),
      row("seven_day_opus", 82, claude),
      row("seven_day", 31, claude),
      row("seven_day_fable", 42, claude, true),
    ];
    const groups = groupLimitRows(rows);
    expect(groups.map((group) => group.driver)).toEqual([claude, antigravity]);
    expect(groups[0]?.rows.map((entry) => entry.window.id)).toEqual([
      "seven_day_opus",
      "seven_day_fable",
      "five_hour",
      "seven_day",
    ]);
    expect(groups[1]?.rows.map((entry) => entry.window.id)).toEqual(["3p-5h", "3p-weekly"]);
  });
});

describe("isWideLimitLabel", () => {
  it("keeps short window names compact and gives shared or compound labels full width", () => {
    expect(isWideLimitLabel("Session")).toBe(false);
    expect(isWideLimitLabel("Weekly")).toBe(false);
    expect(isWideLimitLabel("Opus")).toBe(false);
    expect(isWideLimitLabel("Claude & GPT (shared) · 5-hour")).toBe(true);
    expect(isWideLimitLabel("Cursor Models")).toBe(true);
  });
});

describe("resolveThreadHttpQuotas", () => {
  it("shows only the quota accounts bound to the thread's provider instance", () => {
    const window = { id: "monthly", kind: "monthly", label: "Monthly", usedPercent: 35 } as const;
    const source: UsageLimitSourceSnapshot = {
      id: UsageLimitSourceId.make("quota"),
      kind: "http",
      label: "Quota server",
      checkedAt,
      accounts: [],
      quotaAccounts: [
        { id: "bound", label: "Work plan", providerInstanceId: instanceId, windows: [window] },
        { id: "unbound", label: "Unbound", windows: [window] },
        {
          id: "other",
          label: "Other plan",
          providerInstanceId: ProviderInstanceId.make("other"),
          windows: [window],
        },
      ],
    };
    expect(
      resolveThreadHttpQuotas(instanceId, [source]).map((quota) => quota.accountLabel),
    ).toEqual(["Work plan"]);
    expect(resolveThreadHttpQuotas(null, [source])).toEqual([]);
  });
});
