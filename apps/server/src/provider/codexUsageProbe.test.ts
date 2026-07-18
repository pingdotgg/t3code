import { describe, expect, it } from "vite-plus/test";

import { resolveCodexRateLimitSnapshotUsageLimits } from "./codexUsageProbe.ts";

const CHECKED_AT = "2026-06-20T00:00:00.000Z";
const PRIMARY_RESETS_AT_SECONDS = 1776448800;
const PRIMARY_RESETS_AT_ISO = "2026-04-17T18:00:00.000Z";

describe("resolveCodexRateLimitSnapshotUsageLimits", () => {
  it("builds session and weekly windows from a full snapshot", () => {
    const usage = resolveCodexRateLimitSnapshotUsageLimits({
      checkedAt: CHECKED_AT,
      snapshot: {
        primary: {
          usedPercent: 25,
          resetsAt: PRIMARY_RESETS_AT_SECONDS,
          windowDurationMins: 300,
        },
        secondary: {
          usedPercent: 50,
          resetsAt: PRIMARY_RESETS_AT_SECONDS,
          windowDurationMins: 10080,
        },
      },
    });

    expect(usage).toEqual({
      source: "codexAppServer",
      available: true,
      checkedAt: CHECKED_AT,
      windows: [
        {
          kind: "session",
          label: "Session",
          usedPercent: 25,
          windowDurationMins: 300,
          resetsAt: PRIMARY_RESETS_AT_ISO,
        },
        {
          kind: "weekly",
          label: "Weekly",
          usedPercent: 50,
          windowDurationMins: 10080,
          resetsAt: PRIMARY_RESETS_AT_ISO,
        },
      ],
    });
  });

  it("uses provider window defaults when durations are omitted", () => {
    const usage = resolveCodexRateLimitSnapshotUsageLimits({
      checkedAt: CHECKED_AT,
      snapshot: {
        primary: { usedPercent: 25 },
        secondary: { usedPercent: 50 },
      },
    });

    expect(
      usage.windows.map(({ kind, windowDurationMins }) => ({ kind, windowDurationMins })),
    ).toEqual([
      { kind: "session", windowDurationMins: 300 },
      { kind: "weekly", windowDurationMins: 10080 },
    ]);
  });

  it("omits windows with invalid percentages", () => {
    const usage = resolveCodexRateLimitSnapshotUsageLimits({
      checkedAt: CHECKED_AT,
      snapshot: {
        primary: { usedPercent: Number.NaN },
        secondary: { usedPercent: 50 },
      },
    });

    expect(usage.windows).toHaveLength(1);
    expect(usage.windows[0]?.kind).toBe("weekly");
  });

  it("returns unavailable when no snapshot is reported", () => {
    expect(resolveCodexRateLimitSnapshotUsageLimits({ checkedAt: CHECKED_AT })).toEqual({
      source: "codexAppServer",
      available: false,
      reason: "No Codex subscription quota windows reported.",
      checkedAt: CHECKED_AT,
      windows: [],
    });
  });
});
