import { describe, expect, it } from "vite-plus/test";

import {
  resolveGlanceRailGitPosition,
  resolveGlanceRailUsage,
  summarizeGlanceRail,
  type GlanceRailGitStatusSignal,
  type GlanceRailThreadSignal,
  type GlanceRailUsageSignal,
} from "./glanceRailStats";

function thread(overrides: Partial<GlanceRailThreadSignal> = {}): GlanceRailThreadSignal {
  return {
    archivedAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    latestTurn: null,
    session: null,
    ...overrides,
  };
}

describe("summarizeGlanceRail", () => {
  it("counts running agents and attention states without archived threads", () => {
    const stats = summarizeGlanceRail([
      thread({ latestTurn: { state: "running" } }),
      thread({ session: { status: "starting" } }),
      thread({ hasPendingUserInput: true, session: { status: "running" } }),
      thread({ latestTurn: { state: "error" } }),
      thread({ archivedAt: "2026-09-05T12:00:00.000Z", session: { status: "running" } }),
    ]);

    expect(stats).toEqual({ running: 2, needsAttention: 2, threads: 4 });
  });

  it("treats approvals and session errors as attention states", () => {
    const stats = summarizeGlanceRail([
      thread({ hasPendingApprovals: true }),
      thread({ session: { status: "error" } }),
      thread({ latestTurn: { state: "completed" }, session: { status: "stopped" } }),
    ]);

    expect(stats).toEqual({ running: 0, needsAttention: 2, threads: 3 });
  });
});

describe("resolveGlanceRailGitPosition", () => {
  const status = (
    overrides: Partial<GlanceRailGitStatusSignal> = {},
  ): GlanceRailGitStatusSignal => ({
    isRepo: true,
    refName: "feature/glance-rail",
    hasWorkingTreeChanges: false,
    aheadCount: 0,
    behindCount: 0,
    aheadOfDefaultCount: 0,
    ...overrides,
  });

  it.each([
    [status(), { state: "synced", label: "Synced" }],
    [status({ aheadOfDefaultCount: 3 }), { state: "ahead", label: "3 ahead" }],
    [status({ behindCount: 2 }), { state: "behind", label: "2 behind" }],
    [
      status({ aheadOfDefaultCount: 3, behindCount: 2 }),
      { state: "diverged", label: "3 ahead · 2 behind" },
    ],
    [status({ isRepo: false }), { state: "not-repository", label: "Not a Git repo" }],
  ])("presents the branch position", (input, expected) => {
    expect(resolveGlanceRailGitPosition(input)).toEqual(expected);
  });
});

describe("resolveGlanceRailUsage", () => {
  const usage = (overrides: Partial<GlanceRailUsageSignal> = {}): GlanceRailUsageSignal => ({
    accountLabel: "Codex Personal",
    windows: [
      {
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 25,
      },
      {
        id: "session",
        kind: "session",
        label: "Session",
        usedPercent: 40,
      },
    ],
    ...overrides,
  });

  it("shows the active account's session headroom", () => {
    expect(resolveGlanceRailUsage(usage())).toEqual({
      accountLabel: "Codex Personal",
      windowLabel: "Session",
      remainingPercent: 60,
    });
  });

  it("falls back to the first window when no session window is published", () => {
    expect(
      resolveGlanceRailUsage(
        usage({
          windows: [
            {
              id: "weekly",
              kind: "weekly",
              label: "Weekly",
              usedPercent: 25,
            },
          ],
        }),
      ),
    ).toEqual({
      accountLabel: "Codex Personal",
      windowLabel: "Weekly",
      remainingPercent: 75,
    });
  });

  it.each([
    [null, "without a provider account"],
    [usage({ windows: [] }), "without usage windows"],
    [usage({ unavailable: true }), "when usage is unavailable"],
  ])("omits the readout %s", (input) => {
    expect(resolveGlanceRailUsage(input)).toBeNull();
  });
});
