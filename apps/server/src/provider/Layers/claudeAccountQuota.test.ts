import { describe, expect, it } from "vite-plus/test";

import { mapClaudeAccountQuota } from "./claudeAccountQuota.ts";

const CHECKED_AT = "2026-08-07T12:00:00.000Z";

describe("mapClaudeAccountQuota", () => {
  it("preserves ordered provider-labelled and model-scoped windows", () => {
    expect(
      mapClaudeAccountQuota(
        {
          subscription_type: "max",
          rate_limits_available: true,
          rate_limits: {
            limits: [
              {
                kind: "session",
                percent: 73.2,
                resets_at: "2026-08-07T18:49:00.000Z",
                scope: null,
                severity: "normal",
                is_active: true,
              },
              {
                kind: "weekly_all",
                percent: 39,
                resets_at: "2026-08-12T06:59:00.000Z",
                scope: null,
              },
              {
                kind: "weekly_scoped",
                percent: 124,
                resets_at: "2026-08-12T06:59:00.000Z",
                scope: { model: { display_name: "Fable" } },
              },
            ],
            extra_usage: {
              is_enabled: true,
              utilization: 12,
              used_credits: 6,
              monthly_limit: 50,
              currency: "USD",
            },
          },
        },
        CHECKED_AT,
      ),
    ).toEqual({
      subscriptionType: "max",
      rateLimits: {
        checkedAt: CHECKED_AT,
        windows: [
          {
            id: "session",
            label: "Session",
            usedPercent: 73.2,
            resetsAt: "2026-08-07T18:49:00.000Z",
            severity: "normal",
            isActive: true,
          },
          {
            id: "weekly_all",
            label: "Week · all models",
            usedPercent: 39,
            resetsAt: "2026-08-12T06:59:00.000Z",
          },
          {
            id: "weekly_scoped:Fable",
            label: "Week · Fable",
            usedPercent: 100,
            resetsAt: "2026-08-12T06:59:00.000Z",
          },
        ],
        extraUsage: {
          isEnabled: true,
          usedPercent: 12,
          usedCredits: 6,
          monthlyLimit: 50,
          currency: "USD",
        },
      },
    });
  });

  it("maps the current SDK fallback shape and ignores unavailable quotas", () => {
    expect(
      mapClaudeAccountQuota(
        {
          subscription_type: "pro",
          rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization: 15, resets_at: null },
            seven_day_sonnet: {
              utilization: 27,
              resets_at: "2026-08-14T12:00:00Z",
            },
          },
        },
        CHECKED_AT,
      ),
    ).toEqual({
      subscriptionType: "pro",
      rateLimits: {
        checkedAt: CHECKED_AT,
        windows: [
          { id: "five_hour", label: "Session", usedPercent: 15 },
          {
            id: "seven_day_sonnet",
            label: "Week · Sonnet",
            usedPercent: 27,
            resetsAt: "2026-08-14T12:00:00.000Z",
          },
        ],
      },
    });

    expect(
      mapClaudeAccountQuota(
        {
          subscription_type: "team",
          rate_limits_available: false,
          rate_limits: null,
        },
        CHECKED_AT,
      ),
    ).toEqual({ subscriptionType: "team" });
  });

  it("fails closed for malformed experimental responses", () => {
    expect(mapClaudeAccountQuota({ rate_limits: "changed" }, CHECKED_AT)).toEqual({});
  });
});
