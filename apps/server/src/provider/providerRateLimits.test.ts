import { describe, expect, it } from "vite-plus/test";

import {
  readProviderRateLimitFromPayload,
  readProviderRateLimitFromTurnError,
} from "./providerRateLimits.ts";

const OBSERVED_AT = "2026-09-02T10:00:00.000Z";

describe("readProviderRateLimitFromPayload", () => {
  it("normalizes a Claude rate_limit_event", () => {
    expect(
      readProviderRateLimitFromPayload({
        driver: "claudeAgent",
        observedAt: OBSERVED_AT,
        payload: {
          rateLimits: {
            type: "rate_limit_event",
            rate_limit_info: {
              status: "rejected",
              resetsAt: 1_788_000_000,
              rateLimitType: "five_hour",
              utilization: 100,
            },
          },
        },
      }),
    ).toEqual({
      status: "rejected",
      resetsAt: "2026-08-29T10:40:00.000Z",
      window: "five_hour",
      utilization: 100,
      observedAt: OBSERVED_AT,
    });
  });

  it("maps Claude allowed_warning to warning", () => {
    expect(
      readProviderRateLimitFromPayload({
        driver: "claudeAgent",
        observedAt: OBSERVED_AT,
        payload: {
          rateLimits: { rate_limit_info: { status: "allowed_warning", utilization: 92 } },
        },
      }),
    ).toEqual({ status: "warning", utilization: 92, observedAt: OBSERVED_AT });
  });

  it("normalizes a Codex rate limit snapshot using the hottest window", () => {
    expect(
      readProviderRateLimitFromPayload({
        driver: "codex",
        observedAt: OBSERVED_AT,
        payload: {
          rateLimits: {
            rateLimits: {
              primary: { usedPercent: 40, resetsAt: 1_788_000_000, windowDurationMins: 300 },
              secondary: { usedPercent: 95, resetsAt: 1_788_500_000, windowDurationMins: 10_080 },
            },
          },
        },
      }),
    ).toEqual({
      status: "warning",
      resetsAt: "2026-09-04T05:33:20.000Z",
      window: "10080m",
      utilization: 95,
      observedAt: OBSERVED_AT,
    });
  });

  it("treats a Codex rateLimitReachedType as rejected", () => {
    expect(
      readProviderRateLimitFromPayload({
        driver: "codex",
        observedAt: OBSERVED_AT,
        payload: {
          rateLimits: {
            rateLimits: {
              primary: { usedPercent: 100, resetsAt: 1_788_000_000, windowDurationMins: 300 },
              rateLimitReachedType: "rate_limit_reached",
            },
          },
        },
      })?.status,
    ).toBe("rejected");
  });

  it("ignores payloads it does not understand", () => {
    expect(
      readProviderRateLimitFromPayload({
        driver: "claudeAgent",
        observedAt: OBSERVED_AT,
        payload: { rateLimits: { something: true } },
      }),
    ).toBeUndefined();
    expect(
      readProviderRateLimitFromPayload({ driver: "cursor", observedAt: OBSERVED_AT, payload: {} }),
    ).toBeUndefined();
  });
});

describe("readProviderRateLimitFromTurnError", () => {
  it("recognizes usage limit error text with a short expiry", () => {
    expect(
      readProviderRateLimitFromTurnError({
        driver: "claudeAgent",
        errorMessage: "You've hit your limit · resets 3pm (Asia/Dhaka)",
        observedAt: OBSERVED_AT,
      }),
    ).toEqual({
      status: "rejected",
      resetsAt: "2026-09-02T10:15:00.000Z",
      window: "turn-error",
      observedAt: OBSERVED_AT,
    });
  });

  it("ignores unrelated failures and drivers without structured updates", () => {
    expect(
      readProviderRateLimitFromTurnError({
        driver: "claudeAgent",
        errorMessage: "Claude turn failed.",
        observedAt: OBSERVED_AT,
      }),
    ).toBeUndefined();
    expect(
      readProviderRateLimitFromTurnError({
        driver: "grok",
        errorMessage: "Grok usage limit reached. Try again later.",
        observedAt: OBSERVED_AT,
      }),
    ).toBeUndefined();
    expect(
      readProviderRateLimitFromTurnError({
        driver: "codex",
        errorMessage: undefined,
        observedAt: OBSERVED_AT,
      }),
    ).toBeUndefined();
  });
});
