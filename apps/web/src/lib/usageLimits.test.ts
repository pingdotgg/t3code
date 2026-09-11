import { describe, expect, it } from "vite-plus/test";
import { EventId, type OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";

import {
  deriveLatestUsageLimitsSnapshot,
  formatUsageLimitPercent,
  formatUsageLimitResetLabel,
  formatUsageLimitWindowLabel,
  selectHeadlineUsageLimitWindow,
} from "./usageLimits";

function makeActivity(
  id: string,
  payload: unknown,
  createdAt = "2026-03-23T00:00:00.000Z",
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind: "usage-limits.updated",
    summary: "Usage limits updated",
    payload,
    turnId: TurnId.make("turn-1"),
    createdAt,
  };
}

const NOW = Date.parse("2026-03-23T12:00:00.000Z");

describe("deriveLatestUsageLimitsSnapshot", () => {
  it("returns null without a usable row", () => {
    expect(deriveLatestUsageLimitsSnapshot([])).toBeNull();
    expect(deriveLatestUsageLimitsSnapshot([makeActivity("broken", { windows: [] })])).toBeNull();
  });

  it("takes status from the newest row and merges windows from older rows", () => {
    const snapshot = deriveLatestUsageLimitsSnapshot([
      makeActivity(
        "weekly",
        {
          provider: "claudeAgent",
          status: "ok",
          windows: [
            { id: "seven_day", usedPercent: 31, resetsAt: null, windowDurationMins: 10_080 },
          ],
        },
        "2026-03-23T00:00:00.000Z",
      ),
      makeActivity(
        "session-old",
        {
          provider: "claudeAgent",
          status: "ok",
          windows: [{ id: "five_hour", usedPercent: 40, resetsAt: null, windowDurationMins: 300 }],
        },
        "2026-03-23T01:00:00.000Z",
      ),
      makeActivity(
        "session-new",
        {
          provider: "claudeAgent",
          status: "warning",
          windows: [{ id: "five_hour", usedPercent: 85, resetsAt: null, windowDurationMins: 300 }],
        },
        "2026-03-23T02:00:00.000Z",
      ),
    ]);

    expect(snapshot).toMatchObject({
      provider: "claudeAgent",
      status: "warning",
      updatedAt: "2026-03-23T02:00:00.000Z",
    });
    expect(snapshot?.windows.map((window) => [window.id, window.usedPercent])).toEqual([
      ["five_hour", 85],
      ["seven_day", 31],
    ]);
  });

  it("does not merge windows across providers", () => {
    const snapshot = deriveLatestUsageLimitsSnapshot([
      makeActivity("codex", {
        provider: "codex",
        status: "ok",
        windows: [{ id: "primary", usedPercent: 10 }],
      }),
      makeActivity("claude", {
        provider: "claudeAgent",
        status: "ok",
        windows: [{ id: "five_hour", usedPercent: 20 }],
      }),
    ]);

    expect(snapshot?.provider).toBe("claudeAgent");
    expect(snapshot?.windows.map((window) => window.id)).toEqual(["five_hour"]);
  });

  it("carries plan, credit, and limit context", () => {
    const snapshot = deriveLatestUsageLimitsSnapshot([
      makeActivity("codex", {
        provider: "codex",
        status: "limited",
        limitReason: "rate_limit_reached",
        planType: "plus",
        credits: { hasCredits: true, unlimited: false, balance: "3.00" },
        windows: [{ id: "primary", usedPercent: 250 }],
      }),
    ]);

    expect(snapshot).toMatchObject({
      status: "limited",
      limitReason: "rate_limit_reached",
      planType: "plus",
      credits: { hasCredits: true, unlimited: false, balance: "3.00" },
    });
    expect(snapshot?.windows[0]?.usedPercent).toBe(100);
  });
});

describe("selectHeadlineUsageLimitWindow", () => {
  it("prefers the most used window that has not reset", () => {
    const snapshot = deriveLatestUsageLimitsSnapshot([
      makeActivity("row", {
        provider: "claudeAgent",
        status: "ok",
        windows: [
          { id: "five_hour", usedPercent: 95, resetsAt: "2026-03-23T11:00:00.000Z" },
          { id: "seven_day", usedPercent: 60, resetsAt: "2026-03-30T00:00:00.000Z" },
        ],
      }),
    ]);

    expect(selectHeadlineUsageLimitWindow(snapshot!, NOW)?.id).toBe("seven_day");
  });
});

describe("usage limit formatting", () => {
  it("labels provider windows", () => {
    const window = { usedPercent: 0, resetsAt: null, updatedAt: "" };
    expect(
      formatUsageLimitWindowLabel({ ...window, id: "five_hour", windowDurationMins: 300 }),
    ).toBe("Session");
    expect(
      formatUsageLimitWindowLabel({ ...window, id: "seven_day_opus", windowDurationMins: 10_080 }),
    ).toBe("Weekly (Opus)");
    expect(formatUsageLimitWindowLabel({ ...window, id: "primary", windowDurationMins: 300 })).toBe(
      "Session",
    );
    expect(
      formatUsageLimitWindowLabel({ ...window, id: "secondary", windowDurationMins: 10_080 }),
    ).toBe("Weekly");
    expect(
      formatUsageLimitWindowLabel({ ...window, id: "secondary", windowDurationMins: 1440 }),
    ).toBe("Daily");
    expect(formatUsageLimitWindowLabel({ ...window, id: "custom", windowDurationMins: null })).toBe(
      "custom",
    );
  });

  it("formats reset countdowns", () => {
    expect(formatUsageLimitResetLabel(null, NOW)).toBeNull();
    expect(formatUsageLimitResetLabel("2026-03-23T11:00:00.000Z", NOW)).toBe("Resets soon");
    expect(formatUsageLimitResetLabel("2026-03-23T12:25:00.000Z", NOW)).toBe("Resets in 25m");
    expect(formatUsageLimitResetLabel("2026-03-23T14:10:00.000Z", NOW)).toBe("Resets in 2h 10m");
    expect(formatUsageLimitResetLabel("2026-03-26T15:00:00.000Z", NOW)).toBe("Resets in 3d 3h");
  });

  it("formats percentages", () => {
    expect(formatUsageLimitPercent(0)).toBe("0%");
    expect(formatUsageLimitPercent(4.25)).toBe("4.3%");
    expect(formatUsageLimitPercent(82.6)).toBe("83%");
  });
});
