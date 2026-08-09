import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  claudeUsageSnapshotFromUnknown,
  claudeWindowFromRateLimitEvent,
  codexSnapshotFromUnknown,
  isPrimaryCodexLimit,
} from "./accountLimitsNormalize.ts";

describe("claudeUsageSnapshotFromUnknown", () => {
  it("keeps 5h, weekly and Fable; hides oauth-apps and model weeklies", () => {
    const snapshot = claudeUsageSnapshotFromUnknown({
      subscription_type: "max",
      rate_limits: {
        five_hour: { utilization: 62, resets_at: "2026-08-08T23:00:00.000Z" },
        seven_day: { utilization: 41, resets_at: "2026-08-11T17:00:00.000Z" },
        seven_day_oauth_apps: { utilization: 5, resets_at: null },
        seven_day_opus: { utilization: 78, resets_at: null },
        seven_day_sonnet: { utilization: 12, resets_at: null },
        iguana_necktie: { utilization: 30, resets_at: "2026-08-11T17:00:00.000Z" },
      },
    });

    expect(snapshot?.plan).toBe("max");
    expect(snapshot?.windows.map((window) => window.id)).toEqual([
      "five_hour",
      "seven_day",
      "fable",
    ]);
    expect(snapshot?.windows[2]).toMatchObject({ label: "Fable", usedPercent: 30 });
  });

  it("reads the newer limits array, including a Fable-scoped weekly", () => {
    const snapshot = claudeUsageSnapshotFromUnknown({
      subscription_type: "max",
      rate_limits: {
        five_hour: null,
        limits: [
          { kind: "session", percent: 10, resets_at: "2026-08-08T23:00:00.000Z" },
          { kind: "weekly_all", percent: 20, resets_at: "2026-08-11T17:00:00.000Z" },
          {
            kind: "weekly_scoped",
            percent: 55,
            resets_at: "2026-08-11T17:00:00.000Z",
            scope: { model: { id: "claude-fable-5", display_name: "Fable" } },
          },
          {
            kind: "weekly_scoped",
            percent: 90,
            resets_at: null,
            scope: { model: { id: "claude-opus-5", display_name: "Opus" } },
          },
        ],
      },
    });

    expect(snapshot?.windows.map((window) => [window.id, window.usedPercent])).toEqual([
      ["five_hour", 10],
      ["seven_day", 20],
      ["fable", 55],
    ]);
  });

  it("treats a null utilization as an untouched window", () => {
    const snapshot = claudeUsageSnapshotFromUnknown({
      subscription_type: null,
      rate_limits: { five_hour: { utilization: null, resets_at: null } },
    });
    expect(snapshot?.windows).toEqual([
      { id: "five_hour", label: "5h", usedPercent: 0, resetsAt: null, windowMinutes: 300 },
    ]);
  });

  it("returns empty windows when rate limits do not apply", () => {
    expect(claudeUsageSnapshotFromUnknown({ rate_limits: null })?.windows).toEqual([]);
  });

  it("rejects shapes that are not the usage response", () => {
    expect(claudeUsageSnapshotFromUnknown({ rate_limit_info: {} })).toBeNull();
  });
});

describe("claudeWindowFromRateLimitEvent", () => {
  it("maps the binding window with a unix-seconds reset", () => {
    const window = claudeWindowFromRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed_warning",
        rateLimitType: "five_hour",
        utilization: 87.5,
        resetsAt: 1_786_600_800,
      },
    });
    expect(window).toEqual({
      id: "five_hour",
      label: "5h",
      usedPercent: 87.5,
      resetsAt: DateTime.formatIso(DateTime.makeUnsafe(1_786_600_800_000)),
      windowMinutes: 300,
    });
  });

  it("drops hidden window types", () => {
    expect(
      claudeWindowFromRateLimitEvent({
        rate_limit_info: { rateLimitType: "seven_day_opus", utilization: 90 },
      }),
    ).toBeNull();
  });
});

describe("codexSnapshotFromUnknown", () => {
  it("classifies the current weekly-in-primary payload by duration, not slot", () => {
    // Shaped after a real transcript line: the 5h window is paused, so the
    // weekly rides in the primary slot.
    const snapshot = codexSnapshotFromUnknown({
      limit_id: "codex",
      limit_name: null,
      primary: { used_percent: 14, window_minutes: 10080, resets_at: 1_786_677_720 },
      secondary: null,
      plan_type: "pro",
    });

    expect(snapshot?.plan).toBe("pro");
    expect(snapshot?.windows).toEqual([
      {
        id: "seven_day",
        label: "Week",
        usedPercent: 14,
        resetsAt: DateTime.formatIso(DateTime.makeUnsafe(1_786_677_720_000)),
        windowMinutes: 10080,
      },
    ]);
  });

  it("brings the 5h window back the moment the API ships it again", () => {
    const snapshot = codexSnapshotFromUnknown({
      rateLimits: {
        limitId: "codex",
        planType: "pro",
        primary: { usedPercent: 23, windowDurationMins: 300, resetsAt: 1_786_600_800 },
        secondary: { usedPercent: 14, windowDurationMins: 10080, resetsAt: 1_786_677_720 },
      },
    });
    expect(snapshot?.windows.map((window) => window.id)).toEqual(["five_hour", "seven_day"]);
  });

  it("falls back to slot order for legacy payloads without durations", () => {
    const snapshot = codexSnapshotFromUnknown({
      primary: { used_percent: 40 },
      secondary: { used_percent: 10 },
    });
    expect(snapshot?.windows.map((window) => [window.id, window.usedPercent])).toEqual([
      ["five_hour", 40],
      ["seven_day", 10],
    ]);
  });

  it("flags side meters like Spark so they can be dropped", () => {
    const snapshot = codexSnapshotFromUnknown({
      limit_id: "codex_bengalfox",
      limit_name: "GPT-5.3-Codex-Spark",
      primary: { used_percent: 0, window_minutes: 10080, resets_at: 1_786_828_412 },
    });
    expect(snapshot?.limitId).toBe("codex_bengalfox");
    expect(isPrimaryCodexLimit(snapshot?.limitId ?? null)).toBe(false);
    expect(isPrimaryCodexLimit("codex")).toBe(true);
    expect(isPrimaryCodexLimit(null)).toBe(true);
  });
});
