import { describe, expect, it } from "vite-plus/test";

import {
  codexRateLimitsFailureMessage,
  codexRateLimitsToLimits,
  codexRateLimitsToUpdate,
} from "./codexUsageLimits.ts";

const checkedAt = "2026-07-18T10:00:00.000Z";

describe("codexRateLimitsToLimits", () => {
  it("maps primary and secondary onto the session and weekly windows", () => {
    expect(
      codexRateLimitsToLimits({
        checkedAt,
        snapshot: {
          planType: "plus",
          primary: { usedPercent: 12, resetsAt: 1_784_000_000, windowDurationMins: 300 },
          secondary: { usedPercent: 47, resetsAt: 1_784_500_000, windowDurationMins: 10080 },
        },
      }),
    ).toEqual({
      checkedAt,
      windows: [
        {
          id: "primary",
          kind: "session",
          label: "Session",
          usedPercent: 12,
          windowDurationMins: 300,
          resetsAt: "2026-07-14T03:33:20.000Z",
        },
        {
          id: "secondary",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 47,
          windowDurationMins: 10080,
          resetsAt: "2026-07-19T22:26:40.000Z",
        },
      ],
    });
  });

  it("treats a lone duration-less primary as monthly on Free and Go", () => {
    expect(
      codexRateLimitsToLimits({
        checkedAt,
        snapshot: { planType: "free", primary: { usedPercent: 80, resetsAt: null } },
      }).windows,
    ).toEqual([
      {
        id: "primary",
        kind: "monthly",
        label: "Monthly",
        usedPercent: 80,
        windowDurationMins: 43_200,
      },
    ]);
  });
});

describe("codexRateLimitsToUpdate", () => {
  it("carries only the windows the notification names", () => {
    expect(
      codexRateLimitsToUpdate({
        secondary: { usedPercent: 51, windowDurationMins: 10080 },
      }),
    ).toEqual({
      windows: [
        {
          id: "secondary",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 51,
          windowDurationMins: 10080,
        },
      ],
    });
    expect(codexRateLimitsToUpdate({ planType: "plus" })).toBeUndefined();
  });
});

describe("codexRateLimitsFailureMessage", () => {
  it("labels the app-server error with its code and keeps the message", () => {
    const error = Object.assign(
      new Error("failed to fetch codex rate limits: GET https://x failed: 401 Unauthorized"),
      { code: -32603 },
    );
    expect(codexRateLimitsFailureMessage(error)).toBe(
      "Codex App Server returned a non zero exit code (-32603): failed to fetch codex rate limits: GET https://x failed: 401 Unauthorized",
    );
    expect(codexRateLimitsFailureMessage("socket hang up")).toBe(
      "Codex App Server returned a non zero exit code (unknown): socket hang up",
    );
  });
});
