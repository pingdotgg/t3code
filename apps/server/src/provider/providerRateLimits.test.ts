import { describe, it, assert } from "@effect/vitest";

import {
  mergeRateLimits,
  normalizeClaudeRateLimitInfo,
  normalizeClaudeRateLimitPayload,
  normalizeClaudeUsageResponse,
  normalizeCodexRateLimitSnapshot,
} from "./providerRateLimits.ts";

describe("providerRateLimits", () => {
  it("keeps the 5h window when a weekly-only Claude event arrives", () => {
    const fiveHour = normalizeClaudeRateLimitInfo({
      rate_limit_info: { rateLimitType: "five_hour", utilization: 42 },
    });
    const weekly = normalizeClaudeRateLimitInfo({
      rate_limit_info: { rateLimitType: "seven_day", utilization: 10 },
    });
    assert.isDefined(fiveHour);
    assert.isDefined(weekly);

    const merged = mergeRateLimits(fiveHour, weekly);

    assert.deepStrictEqual(
      merged.windows.map((window) => [window.label, window.usedPercent]),
      [
        ["5h", 42],
        ["Weekly", 10],
      ],
    );
  });

  it("replaces a window when the same one updates, and sorts 5h before weekly", () => {
    const initial = mergeRateLimits(
      normalizeClaudeRateLimitInfo({
        rate_limit_info: { rateLimitType: "seven_day", utilization: 10 },
      }),
      normalizeClaudeRateLimitInfo({
        rate_limit_info: { rateLimitType: "five_hour", utilization: 42 },
      }),
    );

    const updated = mergeRateLimits(
      initial,
      normalizeClaudeRateLimitInfo({
        rate_limit_info: { rateLimitType: "five_hour", utilization: 99 },
      }),
    );

    assert.deepStrictEqual(
      updated.windows.map((window) => [window.label, window.usedPercent]),
      [
        ["5h", 99],
        ["Weekly", 10],
      ],
    );
  });

  it("reads every window at once from the Claude usage response", () => {
    const normalized = normalizeClaudeUsageResponse({
      subscription_type: "max",
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 42, resets_at: "2026-07-27T18:00:00.000Z" },
        seven_day: { utilization: 10, resets_at: "2026-08-01T00:00:00.000Z" },
        seven_day_opus: { utilization: 3, resets_at: null },
      },
    });

    assert.isDefined(normalized);
    assert.strictEqual(normalized.planType, "max");
    assert.deepStrictEqual(
      normalized.windows.map((window) => [window.label, window.usedPercent]),
      [
        ["5h", 42],
        ["Weekly", 10],
        ["Weekly (Opus)", 3],
      ],
    );
    // `resets_at` is already ISO and must survive without epoch conversion.
    assert.strictEqual(normalized.windows[0]?.resetsAt, "2026-07-27T18:00:00.000Z");
    assert.isUndefined(normalized.windows[2]?.resetsAt);
  });

  it("reports empty windows when plan limits do not apply", () => {
    const normalized = normalizeClaudeUsageResponse({
      subscription_type: null,
      rate_limits_available: false,
      rate_limits: null,
    });

    assert.isDefined(normalized);
    assert.deepStrictEqual(normalized.windows, []);
  });

  it("lets an empty window list clear windows accumulated earlier", () => {
    const accumulated = normalizeClaudeRateLimitInfo({
      rate_limit_info: { rateLimitType: "five_hour", utilization: 42 },
    });

    const cleared = mergeRateLimits(accumulated, { windows: [] });

    assert.deepStrictEqual(cleared.windows, []);
  });

  it("shows overage only when enabled and actually in use", () => {
    const idle = normalizeClaudeUsageResponse({
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 42 },
        extra_usage: { is_enabled: true, utilization: 0 },
      },
    });
    const active = normalizeClaudeUsageResponse({
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 100 },
        extra_usage: { is_enabled: true, utilization: 12 },
      },
    });

    assert.deepStrictEqual(
      idle?.windows.map((window) => window.label),
      ["5h"],
    );
    assert.deepStrictEqual(
      active?.windows.map((window) => [window.label, window.usedPercent]),
      [
        ["5h", 100],
        ["Overage", 12],
      ],
    );
  });

  it("routes both Claude payload shapes through one normalizer", () => {
    const fromEvent = normalizeClaudeRateLimitPayload({
      rate_limit_info: { rateLimitType: "five_hour", utilization: 42 },
    });
    const fromRead = normalizeClaudeRateLimitPayload({
      rate_limits_available: true,
      rate_limits: { seven_day: { utilization: 10 } },
    });

    assert.deepStrictEqual(
      fromEvent?.windows.map((window) => window.label),
      ["5h"],
    );
    assert.deepStrictEqual(
      fromRead?.windows.map((window) => window.label),
      ["Weekly"],
    );
  });

  it("keeps the fuller picture when an event lands after a control read", () => {
    const fromRead = normalizeClaudeRateLimitPayload({
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 42 },
        seven_day: { utilization: 10 },
      },
    });
    const laterEvent = normalizeClaudeRateLimitPayload({
      rate_limit_info: { rateLimitType: "five_hour", utilization: 55 },
    });

    const merged = mergeRateLimits(fromRead, laterEvent);

    assert.deepStrictEqual(
      merged.windows.map((window) => [window.label, window.usedPercent]),
      [
        ["5h", 55],
        ["Weekly", 10],
      ],
    );
  });

  it("labels Codex windows from their duration and reads percent as-is", () => {
    const normalized = normalizeCodexRateLimitSnapshot({
      planType: "plus",
      primary: { usedPercent: 20, windowDurationMins: 300 },
      secondary: { usedPercent: 65, windowDurationMins: 10_080 },
    });

    assert.isDefined(normalized);
    assert.strictEqual(normalized.planType, "plus");
    assert.deepStrictEqual(
      normalized.windows.map((window) => [window.label, window.usedPercent]),
      [
        ["5h", 20],
        ["Weekly", 65],
      ],
    );
  });

  it("keeps a Codex reading of 1 percent at 1 percent", () => {
    const normalized = normalizeCodexRateLimitSnapshot({
      primary: { usedPercent: 1, windowDurationMins: 300 },
    });

    assert.strictEqual(normalized?.windows[0]?.usedPercent, 1);
  });

  it("returns undefined when a payload carries no usable window", () => {
    assert.isUndefined(normalizeClaudeRateLimitInfo({ rate_limit_info: {} }));
    assert.isUndefined(normalizeCodexRateLimitSnapshot({ planType: "plus" }));
    assert.isUndefined(normalizeCodexRateLimitSnapshot(undefined));
    assert.isUndefined(normalizeClaudeUsageResponse(undefined));
  });
});
