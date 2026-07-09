import { describe, expect, it } from "vite-plus/test";
import {
  type ClaudeAccountUsage,
  EventId,
  type OrchestrationThreadActivity,
  TurnId,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";

import { deriveLatestContextWindowSnapshot } from "~/lib/contextWindow";
import {
  formatResetCountdown,
  type HeaderUsageStatsVisibility,
  resolveScopedWeeklyLabel,
  selectHeaderUsageStats,
  selectHeaderUsageStatsVisibility,
  SPEND_STAT_PARTIAL_TOOLTIP,
  SPEND_STAT_TOOLTIP,
} from "./HeaderUsageStats";

function makeActivity(id: string, payload: unknown): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind: "context-window.updated",
    summary: "context-window.updated",
    payload,
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-03-23T00:00:00.000Z",
  };
}

const contextWindow = deriveLatestContextWindowSnapshot([
  makeActivity("activity-1", { usedTokens: 167_000, maxTokens: 200_000, costUsd: 1.416 }),
]);

const claudeUsage: ClaudeAccountUsage = {
  limits: [
    { kind: "session", percent: 42, resetsAt: "2026-03-23T04:36:00.000Z" },
    { kind: "weekly_all", percent: 63.4, resetsAt: "2026-03-26T12:06:00.000Z" },
    { kind: "weekly_scoped", percent: 18, scopeLabel: "Fable" },
  ],
  fetchedAt: "2026-03-23T00:00:00.000Z",
};

const allVisible: HeaderUsageStatsVisibility = {
  context: true,
  spend: true,
  session: true,
  weekly: true,
  scopedWeekly: true,
};

describe("selectHeaderUsageStatsVisibility", () => {
  it("defaults every stat to hidden", () => {
    expect(selectHeaderUsageStatsVisibility(DEFAULT_CLIENT_SETTINGS)).toEqual({
      context: false,
      spend: false,
      session: false,
      weekly: false,
      scopedWeekly: false,
    });
  });
});

describe("selectHeaderUsageStats", () => {
  it("returns all stats with formatted values when toggled on and data is available", () => {
    const stats = selectHeaderUsageStats({
      visibility: allVisible,
      contextWindow,
      claudeUsage,
    });

    expect(stats.map((stat) => ({ id: stat.id, label: stat.label, value: stat.value }))).toEqual([
      { id: "context", label: "Context", value: "167k" },
      { id: "spend", label: "Spend", value: "$1.42" },
      { id: "session", label: "Session", value: "42%" },
      { id: "weekly", label: "Weekly", value: "63%" },
      { id: "scopedWeekly", label: "Fable", value: "18%" },
    ]);
  });

  it("threads each limit's resetsAt through to the matching stat", () => {
    const stats = selectHeaderUsageStats({
      visibility: allVisible,
      contextWindow,
      claudeUsage,
    });

    const byId = Object.fromEntries(stats.map((stat) => [stat.id, stat.resetsAt]));
    expect(byId.session).toBe("2026-03-23T04:36:00.000Z");
    expect(byId.weekly).toBe("2026-03-26T12:06:00.000Z");
    // The scoped-weekly limit has no resetsAt in the fixture.
    expect(byId.scopedWeekly).toBeUndefined();
    // Non-limit stats never carry a reset time.
    expect(byId.context).toBeUndefined();
    expect(byId.spend).toBeUndefined();
  });

  it("attaches the estimate caveat tooltip to the spend stat only", () => {
    const stats = selectHeaderUsageStats({
      visibility: allVisible,
      contextWindow,
      claudeUsage,
    });

    expect(stats.find((stat) => stat.id === "spend")?.tooltip).toBe(SPEND_STAT_TOOLTIP);
    expect(stats.filter((stat) => stat.tooltip !== undefined).map((stat) => stat.id)).toEqual([
      "spend",
    ]);
  });

  it("marks the spend stat as partial when some usage had no list price", () => {
    const stats = selectHeaderUsageStats({
      visibility: allVisible,
      contextWindow: deriveLatestContextWindowSnapshot([
        makeActivity("activity-1", { usedTokens: 10_000, costUsd: 1.416 }),
        // e.g. a Codex session on a model with no published API list price.
        makeActivity("activity-2", { usedTokens: 20_000, costUsdIncomplete: true }),
      ]),
      claudeUsage: null,
    });

    const spend = stats.find((stat) => stat.id === "spend");
    expect(spend?.label).toBe("Spend (partial)");
    expect(spend?.value).toBe("$1.42");
    expect(spend?.tooltip).toBe(SPEND_STAT_PARTIAL_TOOLTIP);
  });

  it("omits the spend stat when it is toggled off", () => {
    const stats = selectHeaderUsageStats({
      visibility: { ...allVisible, spend: false },
      contextWindow,
      claudeUsage,
    });

    expect(stats.map((stat) => stat.id)).toEqual(["context", "session", "weekly", "scopedWeekly"]);
  });

  it("omits the spend stat when no cost data ever arrived", () => {
    const stats = selectHeaderUsageStats({
      visibility: allVisible,
      contextWindow: deriveLatestContextWindowSnapshot([
        makeActivity("activity-1", { usedTokens: 167_000, maxTokens: 200_000 }),
      ]),
      claudeUsage: null,
    });

    expect(stats.map((stat) => stat.id)).toEqual(["context"]);
  });

  it("assigns a distinct color per stat", () => {
    const stats = selectHeaderUsageStats({
      visibility: allVisible,
      contextWindow,
      claudeUsage,
    });

    expect(new Set(stats.map((stat) => stat.colorClass)).size).toBe(stats.length);
  });

  it("omits stats that are toggled off", () => {
    const stats = selectHeaderUsageStats({
      visibility: { ...allVisible, session: false, weekly: false },
      contextWindow,
      claudeUsage,
    });

    expect(stats.map((stat) => stat.id)).toEqual(["context", "spend", "scopedWeekly"]);
  });

  it("renders nothing for a toggled-on stat whose data is unavailable", () => {
    const stats = selectHeaderUsageStats({
      visibility: allVisible,
      contextWindow: null,
      claudeUsage: {
        limits: [{ kind: "session", percent: 42 }],
        fetchedAt: "2026-03-23T00:00:00.000Z",
      },
    });

    expect(stats.map((stat) => stat.id)).toEqual(["session"]);
  });

  it("returns no stats when no data source is available", () => {
    const stats = selectHeaderUsageStats({
      visibility: allVisible,
      contextWindow: null,
      claudeUsage: null,
    });

    expect(stats).toEqual([]);
  });

  it("falls back to a generic scoped label when the limit has none", () => {
    const stats = selectHeaderUsageStats({
      visibility: allVisible,
      contextWindow: null,
      claudeUsage: {
        limits: [{ kind: "weekly_scoped", percent: 18 }],
        fetchedAt: "2026-03-23T00:00:00.000Z",
      },
    });

    expect(stats).toEqual([
      expect.objectContaining({ id: "scopedWeekly", label: "Scoped", value: "18%" }),
    ]);
  });
});

describe("formatResetCountdown", () => {
  const now = new Date("2026-03-23T00:00:00.000Z").getTime();

  it("formats hours and minutes without days", () => {
    expect(formatResetCountdown("2026-03-23T04:36:00.000Z", now)).toBe("4h36m");
  });

  it("formats days, hours, and minutes", () => {
    expect(formatResetCountdown("2026-03-26T12:06:00.000Z", now)).toBe("3d12h6m");
  });

  it("shows only minutes when under an hour", () => {
    expect(formatResetCountdown("2026-03-23T00:36:00.000Z", now)).toBe("36m");
  });

  it("keeps a zero-hour segment when days are present", () => {
    expect(formatResetCountdown("2026-03-26T00:06:00.000Z", now)).toBe("3d0h6m");
  });

  it("drops seconds (floors to the minute)", () => {
    expect(formatResetCountdown("2026-03-23T04:36:59.000Z", now)).toBe("4h36m");
  });

  it("returns null for a reset already in the past", () => {
    expect(formatResetCountdown("2026-03-22T23:00:00.000Z", now)).toBeNull();
  });

  it("returns null for an unparseable timestamp", () => {
    expect(formatResetCountdown("not-a-date", now)).toBeNull();
  });
});

describe("resolveScopedWeeklyLabel", () => {
  it("uses the scoped limit's scopeLabel", () => {
    expect(resolveScopedWeeklyLabel(claudeUsage)).toBe("Fable");
  });

  it("falls back when usage or the scoped limit is missing", () => {
    expect(resolveScopedWeeklyLabel(null)).toBe("Scoped");
    expect(
      resolveScopedWeeklyLabel({
        limits: [{ kind: "session", percent: 1 }],
        fetchedAt: "2026-03-23T00:00:00.000Z",
      }),
    ).toBe("Scoped");
  });
});
