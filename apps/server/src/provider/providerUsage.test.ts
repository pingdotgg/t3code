import { assert, describe, it } from "@effect/vitest";

import {
  applyClaudeRateLimitEvent,
  applyCodexRateLimitEvent,
  pickNewestUsage,
  usageFromCodexRateLimitsRead,
} from "./providerUsage.ts";

const NOW_ISO = "2026-08-06T12:00:00.000Z";
const LATER_ISO = "2026-08-06T13:00:00.000Z";

// 2026-08-06T14:00:00.000Z as epoch seconds.
const RESET_EPOCH_SECONDS = 1_786_024_800;
const RESET_ISO = "2026-08-06T14:00:00.000Z";

const claudePayload = (info: Record<string, unknown>) => ({
  rateLimits: {
    type: "rate_limit_event",
    rate_limit_info: info,
  },
});

describe("applyClaudeRateLimitEvent", () => {
  it("normalizes a five_hour window from the SDK payload", () => {
    const usage = applyClaudeRateLimitEvent(
      undefined,
      claudePayload({
        status: "allowed",
        rateLimitType: "five_hour",
        utilization: 42,
        resetsAt: RESET_EPOCH_SECONDS,
      }),
      NOW_ISO,
    );

    assert.deepStrictEqual(usage, {
      windows: [
        {
          key: "five_hour",
          label: "5h",
          usedPercent: 42,
          status: "ok",
          resetsAt: RESET_ISO,
        },
      ],
      updatedAt: NOW_ISO,
    });
  });

  it("accumulates windows across events and keeps five_hour first", () => {
    const first = applyClaudeRateLimitEvent(
      undefined,
      claudePayload({ status: "allowed", rateLimitType: "seven_day", utilization: 13 }),
      NOW_ISO,
    );
    const second = applyClaudeRateLimitEvent(
      first,
      claudePayload({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 78 }),
      LATER_ISO,
    );

    assert.deepStrictEqual(
      second?.windows.map((window) => [window.key, window.usedPercent, window.status]),
      [
        ["five_hour", 78, "warning"],
        ["seven_day", 13, "ok"],
      ],
    );
    assert.strictEqual(second?.updatedAt, LATER_ISO);
  });

  it("overwrites a previously observed window of the same type", () => {
    const first = applyClaudeRateLimitEvent(
      undefined,
      claudePayload({ status: "allowed", rateLimitType: "five_hour", utilization: 42 }),
      NOW_ISO,
    );
    const second = applyClaudeRateLimitEvent(
      first,
      claudePayload({ status: "rejected", rateLimitType: "five_hour", utilization: 150 }),
      LATER_ISO,
    );

    assert.deepStrictEqual(
      second?.windows.map((window) => [window.key, window.usedPercent, window.status]),
      [["five_hour", 100, "exhausted"]],
    );
  });

  it("returns undefined when the payload carries no utilization", () => {
    assert.strictEqual(
      applyClaudeRateLimitEvent(undefined, claudePayload({ status: "allowed" }), NOW_ISO),
      undefined,
    );
    assert.strictEqual(
      applyClaudeRateLimitEvent(undefined, { rateLimits: "junk" }, NOW_ISO),
      undefined,
    );
    assert.strictEqual(applyClaudeRateLimitEvent(undefined, null, NOW_ISO), undefined);
  });

  it("defaults an untyped window to five_hour", () => {
    const usage = applyClaudeRateLimitEvent(
      undefined,
      claudePayload({ status: "allowed", utilization: 10 }),
      NOW_ISO,
    );
    assert.strictEqual(usage?.windows[0]?.key, "five_hour");
    assert.strictEqual(usage?.windows[0]?.label, "5h");
  });
});

const codexNotificationPayload = (snapshot: Record<string, unknown>) => ({
  // The runtime event payload wraps the whole `account/rateLimits/updated`
  // notification, which itself nests the snapshot under `rateLimits`.
  rateLimits: { rateLimits: snapshot },
});

describe("applyCodexRateLimitEvent", () => {
  it("normalizes primary and secondary windows with duration labels", () => {
    const usage = applyCodexRateLimitEvent(
      undefined,
      codexNotificationPayload({
        primary: { usedPercent: 35.4, windowDurationMins: 300, resetsAt: RESET_EPOCH_SECONDS },
        secondary: { usedPercent: 12, windowDurationMins: 10_080 },
      }),
      NOW_ISO,
    );

    assert.deepStrictEqual(usage, {
      windows: [
        { key: "primary", label: "5h", usedPercent: 35.4, resetsAt: RESET_ISO },
        { key: "secondary", label: "1w", usedPercent: 12 },
      ],
      updatedAt: NOW_ISO,
    });
  });

  it("merges sparse updates into previously observed windows", () => {
    const first = applyCodexRateLimitEvent(
      undefined,
      codexNotificationPayload({
        primary: { usedPercent: 35, windowDurationMins: 300 },
        secondary: { usedPercent: 12, windowDurationMins: 10_080 },
      }),
      NOW_ISO,
    );
    const second = applyCodexRateLimitEvent(
      first,
      codexNotificationPayload({ primary: { usedPercent: 60, windowDurationMins: 300 } }),
      LATER_ISO,
    );

    assert.deepStrictEqual(
      second?.windows.map((window) => [window.key, window.usedPercent]),
      [
        ["primary", 60],
        ["secondary", 12],
      ],
    );
  });

  it("marks a fully used window as exhausted", () => {
    const usage = applyCodexRateLimitEvent(
      undefined,
      codexNotificationPayload({ primary: { usedPercent: 100, windowDurationMins: 300 } }),
      NOW_ISO,
    );
    assert.strictEqual(usage?.windows[0]?.status, "exhausted");
  });

  it("returns undefined when no window is present", () => {
    assert.strictEqual(
      applyCodexRateLimitEvent(undefined, codexNotificationPayload({}), NOW_ISO),
      undefined,
    );
    assert.strictEqual(applyCodexRateLimitEvent(undefined, null, NOW_ISO), undefined);
  });
});

describe("usageFromCodexRateLimitsRead", () => {
  it("builds usage from a probe-time read response", () => {
    const usage = usageFromCodexRateLimitsRead(
      {
        rateLimits: {
          primary: { usedPercent: 5, windowDurationMins: 300 },
          secondary: { usedPercent: 1, windowDurationMins: 10_080 },
        },
      },
      NOW_ISO,
    );
    assert.deepStrictEqual(
      usage?.windows.map((window) => [window.key, window.label]),
      [
        ["primary", "5h"],
        ["secondary", "1w"],
      ],
    );
  });

  it("returns undefined for missing or empty responses", () => {
    assert.strictEqual(usageFromCodexRateLimitsRead(undefined, NOW_ISO), undefined);
    assert.strictEqual(usageFromCodexRateLimitsRead({ rateLimits: {} }, NOW_ISO), undefined);
  });

  it("tolerates epoch milliseconds in resetsAt", () => {
    const usage = usageFromCodexRateLimitsRead(
      {
        rateLimits: {
          primary: {
            usedPercent: 5,
            windowDurationMins: 300,
            resetsAt: RESET_EPOCH_SECONDS * 1000,
          },
        },
      },
      NOW_ISO,
    );
    assert.strictEqual(usage?.windows[0]?.resetsAt, RESET_ISO);
  });
});

describe("pickNewestUsage", () => {
  const older = { windows: [], updatedAt: NOW_ISO };
  const newer = { windows: [], updatedAt: LATER_ISO };

  it("prefers the more recently updated snapshot", () => {
    assert.strictEqual(pickNewestUsage(older, newer), newer);
    assert.strictEqual(pickNewestUsage(newer, older), newer);
  });

  it("falls back to whichever side is defined", () => {
    assert.strictEqual(pickNewestUsage(undefined, newer), newer);
    assert.strictEqual(pickNewestUsage(older, undefined), older);
    assert.strictEqual(pickNewestUsage(undefined, undefined), undefined);
  });
});
