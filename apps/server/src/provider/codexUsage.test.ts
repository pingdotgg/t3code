import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { normalizeCodexUsageSnapshot } from "./codexUsage.ts";

const instanceId = ProviderInstanceId.make("codex");

describe("normalizeCodexUsageSnapshot", () => {
  it("prefers the codex multi-bucket over the legacy bucket", () => {
    const snapshot = normalizeCodexUsageSnapshot({
      providerInstanceId: instanceId,
      source: "read",
      checkedAt: "2026-05-04T00:00:00.000Z",
      payload: {
        rateLimits: {
          primary: { usedPercent: 90, windowDurationMins: 300 },
        },
        rateLimitsByLimitId: {
          codex: {
            primary: { usedPercent: 25, windowDurationMins: 300 },
          },
        },
      },
    });

    expect(snapshot?.windows[0]).toMatchObject({
      kind: "five-hour",
      usedPercent: 25,
      remainingPercent: 75,
    });
  });

  it("falls back to the top-level rateLimits bucket", () => {
    const snapshot = normalizeCodexUsageSnapshot({
      providerInstanceId: instanceId,
      source: "read",
      payload: {
        rateLimits: {
          primary: { usedPercent: 60, windowDurationMins: 300 },
        },
      },
    });

    expect(snapshot?.windows).toEqual([
      {
        kind: "five-hour",
        usedPercent: 60,
        remainingPercent: 40,
        resetsAt: null,
        windowDurationMins: 300,
      },
    ]);
  });

  it("accepts a direct rate-limit snapshot payload", () => {
    const snapshot = normalizeCodexUsageSnapshot({
      providerInstanceId: instanceId,
      source: "notification",
      payload: {
        primary: { usedPercent: 42, windowDurationMins: 300 },
        secondary: { usedPercent: 70, windowDurationMins: 10_080 },
      },
    });

    expect(snapshot?.windows.map((window) => window.usedPercent)).toEqual([42, 70]);
    expect(snapshot?.source).toBe("notification");
  });

  it("maps the 5h and weekly windows", () => {
    const snapshot = normalizeCodexUsageSnapshot({
      providerInstanceId: instanceId,
      source: "read",
      payload: {
        rateLimits: {
          primary: { usedPercent: 10, windowDurationMins: 300 },
          secondary: { usedPercent: 55, windowDurationMins: 10_080 },
        },
      },
    });

    expect(snapshot?.windows.map((window) => window.kind)).toEqual(["five-hour", "weekly"]);
  });

  it("maps Codex limit-id buckets when duration metadata is absent", () => {
    const snapshot = normalizeCodexUsageSnapshot({
      providerInstanceId: instanceId,
      source: "read",
      payload: {
        rateLimits: {},
        rateLimitsByLimitId: {
          FiveHourLimit: {
            primary: { usedPercent: 12 },
          },
          WeeklyLimit: {
            primary: { usedPercent: 34 },
          },
        },
      },
    });

    expect(snapshot?.windows).toEqual([
      {
        kind: "five-hour",
        usedPercent: 12,
        remainingPercent: 88,
        resetsAt: null,
        windowDurationMins: null,
      },
      {
        kind: "weekly",
        usedPercent: 34,
        remainingPercent: 66,
        resetsAt: null,
        windowDurationMins: null,
      },
    ]);
  });

  it("sorts fallback limit-id buckets by display priority", () => {
    const snapshot = normalizeCodexUsageSnapshot({
      providerInstanceId: instanceId,
      source: "read",
      payload: {
        rateLimits: {},
        rateLimitsByLimitId: {
          WeeklyLimit: {
            primary: { usedPercent: 34 },
          },
          FiveHourLimit: {
            primary: { usedPercent: 12 },
          },
        },
      },
    });

    expect(snapshot?.windows.map((window) => window.kind)).toEqual(["five-hour", "weekly"]);
  });

  it("carries rate limit reached type from limit-id fallback buckets", () => {
    const snapshot = normalizeCodexUsageSnapshot({
      providerInstanceId: instanceId,
      source: "read",
      payload: {
        rateLimits: {},
        rateLimitsByLimitId: {
          FiveHourLimit: {
            primary: { usedPercent: 100 },
            rateLimitReachedType: "primary",
          },
        },
      },
    });

    expect(snapshot?.rateLimitReachedType).toBe("primary");
  });

  it("uses Codex primary and secondary semantics when durations are unknown", () => {
    const snapshot = normalizeCodexUsageSnapshot({
      providerInstanceId: instanceId,
      source: "read",
      payload: {
        rateLimits: {
          primary: { usedPercent: 10, windowDurationMins: 15 },
          secondary: null,
        },
      },
    });

    expect(snapshot?.windows).toEqual([
      {
        kind: "five-hour",
        usedPercent: 10,
        remainingPercent: 90,
        resetsAt: null,
        windowDurationMins: 15,
      },
    ]);
  });

  it("accepts the long duration field name", () => {
    const snapshot = normalizeCodexUsageSnapshot({
      providerInstanceId: instanceId,
      source: "read",
      payload: {
        rateLimits: {
          primary: { usedPercent: 21, windowDurationMinutes: 300 },
        },
      },
    });

    expect(snapshot?.windows[0]).toMatchObject({
      kind: "five-hour",
      usedPercent: 21,
      remainingPercent: 79,
      windowDurationMins: 300,
    });
  });

  it("clamps remaining percent at zero", () => {
    const snapshot = normalizeCodexUsageSnapshot({
      providerInstanceId: instanceId,
      source: "read",
      payload: {
        rateLimits: {
          primary: { usedPercent: 120, windowDurationMins: 300 },
        },
      },
    });

    expect(snapshot?.windows[0]?.usedPercent).toBe(100);
    expect(snapshot?.windows[0]?.remainingPercent).toBe(0);
  });
});
