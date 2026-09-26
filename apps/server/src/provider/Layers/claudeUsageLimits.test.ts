import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { describe, expect, it } from "vite-plus/test";

import { applyUsageLimitsUpdate, resolveUsageLimitsAfterProbe } from "../providerUsageLimits.ts";
import {
  claudeAccountReportsSubscriptionUsage,
  claudeProbeUsageLimits,
  claudeRateLimitEventToUpdate,
  claudeUsageResponseToLimits,
  makeClaudeScopedLimitNames,
  recordClaudeUsageResponse,
} from "./claudeUsageLimits.ts";

const checkedAt = "2026-07-18T10:00:00.000Z";
const noNames = { overageIncluded: undefined } as const;

describe("claudeUsageResponseToLimits", () => {
  it("maps the session, weekly, and model-scoped weekly windows", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: {
          rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization: 54, resets_at: "2026-07-18T14:39:00Z" },
            seven_day: { utilization: 18.4, resets_at: "2026-07-24T08:59:00+00:00" },
            seven_day_opus: { utilization: 3, resets_at: null },
            // Newer CLIs add this on top of the typed keys; the pinned SDK
            // typings do not know it yet.
            ...({
              model_scoped: [
                { display_name: "Fable", utilization: 73, resets_at: "2026-07-24T08:59:00Z" },
                { display_name: "Ghost", utilization: null, resets_at: null },
              ],
            } as object),
            extra_usage: {
              is_enabled: false,
              monthly_limit: null,
              used_credits: null,
              utilization: null,
            },
          },
        },
      }),
    ).toEqual({
      names: { overageIncluded: "Fable" },
      limits: {
        checkedAt,
        windows: [
          {
            id: "five_hour",
            kind: "session",
            label: "Session",
            usedPercent: 54,
            windowDurationMins: 300,
            resetsAt: "2026-07-18T14:39:00.000Z",
          },
          {
            id: "seven_day",
            kind: "weekly",
            label: "Weekly",
            usedPercent: 18.4,
            windowDurationMins: 10080,
            resetsAt: "2026-07-24T08:59:00.000Z",
          },
          {
            id: "seven_day_fable",
            kind: "weekly",
            label: "Weekly · Fable",
            usedPercent: 73,
            windowDurationMins: 10080,
            resetsAt: "2026-07-24T08:59:00.000Z",
          },
        ],
      },
    });
  });

  it("names the overage-included bucket only from a scoped entry that drew a row", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: {
          rate_limits_available: true,
          rate_limits: {
            ...({
              model_scoped: [
                { display_name: "Ghost", utilization: null, resets_at: null },
                { display_name: "Fable", utilization: 5, resets_at: null },
              ],
            } as object),
          },
        },
      }).names,
    ).toEqual({ overageIncluded: "Fable" });
  });

  it("reports API key and Bedrock accounts as unsupported", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: { rate_limits_available: false, rate_limits: null },
      }).limits,
    ).toEqual({ checkedAt, windows: [], unavailable: { reason: "unsupported" } });
  });

  it("treats a null rate-limit body as a failed probe", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: { rate_limits_available: true, rate_limits: null },
      }).limits,
    ).toEqual({ checkedAt, windows: [], unavailable: { reason: "probeFailed" } });
  });

  it("skips a window the endpoint reports without a utilization", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: {
          rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization: null, resets_at: null },
            seven_day: { utilization: 250, resets_at: null },
          },
        },
      }).limits.windows,
    ).toEqual([
      {
        id: "seven_day",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 100,
        windowDurationMins: 10080,
      },
    ]);
  });
});

const noAccount = {
  subscriptionType: undefined,
  tokenSource: undefined,
  apiProvider: undefined,
} as const;

describe("claudeAccountReportsSubscriptionUsage", () => {
  it("treats a named subscription or known OAuth source as subscription usage", () => {
    expect(
      claudeAccountReportsSubscriptionUsage({
        ...noAccount,
        subscriptionType: "max",
      }),
    ).toBe(true);
    expect(claudeAccountReportsSubscriptionUsage({ ...noAccount, tokenSource: "oauth" })).toBe(
      true,
    );
    expect(claudeAccountReportsSubscriptionUsage({ ...noAccount, tokenSource: "claude.ai" })).toBe(
      true,
    );
    expect(
      claudeAccountReportsSubscriptionUsage({
        ...noAccount,
        tokenSource: "CLAUDE_CODE_OAUTH_TOKEN",
      }),
    ).toBe(true);
  });

  it("rejects API-key, cloud, and unknown token sources", () => {
    expect(
      claudeAccountReportsSubscriptionUsage({ ...noAccount, tokenSource: "ANTHROPIC_AUTH_TOKEN" }),
    ).toBe(false);
    expect(claudeAccountReportsSubscriptionUsage({ ...noAccount, apiProvider: "vertex" })).toBe(
      false,
    );
    expect(
      claudeAccountReportsSubscriptionUsage({ ...noAccount, tokenSource: "some-other-key" }),
    ).toBe(false);
    expect(claudeAccountReportsSubscriptionUsage(noAccount)).toBe(false);
  });
});

describe("claudeProbeUsageLimits", () => {
  it("keeps API key and Bedrock logins unsupported", () => {
    const unavailable = { rate_limits_available: false, rate_limits: null } as const;
    expect(
      claudeProbeUsageLimits({
        checkedAt,
        usage: unavailable,
        account: { ...noAccount, tokenSource: "ANTHROPIC_AUTH_TOKEN" },
      }).limits.unavailable?.reason,
    ).toBe("unsupported");
    expect(
      claudeProbeUsageLimits({
        checkedAt,
        usage: unavailable,
        account: { ...noAccount, apiProvider: "bedrock" },
      }).limits.unavailable?.reason,
    ).toBe("unsupported");
    expect(
      claudeProbeUsageLimits({
        checkedAt,
        usage: unavailable,
        account: { ...noAccount, tokenSource: "some-other-key" },
      }).limits.unavailable?.reason,
    ).toBe("unsupported");
  });

  it("does not lock a subscription instance that returned no windows", () => {
    const account = { subscriptionType: "max", tokenSource: "oauth", apiProvider: undefined };
    const oauthOnly = { ...noAccount, tokenSource: "claude.ai" };
    for (const usage of [
      { rate_limits_available: false, rate_limits: null },
      { rate_limits_available: true, rate_limits: null },
    ] as const) {
      expect(claudeProbeUsageLimits({ checkedAt, usage, account }).limits.unavailable?.reason).toBe(
        "probeFailed",
      );
    }
    expect(
      claudeProbeUsageLimits({
        checkedAt,
        usage: { rate_limits_available: false, rate_limits: null },
        account: oauthOnly,
      }).limits.unavailable?.reason,
    ).toBe("probeFailed");
    expect(
      claudeProbeUsageLimits({
        checkedAt,
        usage: undefined,
        account,
      }).limits.unavailable?.reason,
    ).toBe("probeFailed");
  });

  it("publishes a second instance's turn windows and keeps them across the next bad probe", () => {
    const account = { subscriptionType: "max", tokenSource: "oauth", apiProvider: undefined };
    const probed = claudeProbeUsageLimits({
      checkedAt,
      account,
      usage: { rate_limits_available: false, rate_limits: null },
    });
    const update = claudeRateLimitEventToUpdate(
      {
        status: "rejected",
        rateLimitType: "five_hour",
        utilization: 1.09,
        resetsAt: 1_789_938_600,
      },
      probed.names,
    );
    const recovered = applyUsageLimitsUpdate({
      previous: probed.limits,
      checkedAt: "2026-09-20T18:58:27.751Z",
      update: update!,
    });
    expect(recovered?.windows).toEqual([
      {
        id: "five_hour",
        kind: "session",
        label: "Session",
        usedPercent: 100,
        windowDurationMins: 300,
        resetsAt: "2026-09-20T21:10:00.000Z",
      },
    ]);
    expect(recovered?.unavailable?.reason).toBe("probeFailed");
    const again = claudeProbeUsageLimits({
      checkedAt: "2026-09-20T19:00:00.000Z",
      account,
      usage: { rate_limits_available: true, rate_limits: null },
    });
    expect(resolveUsageLimitsAfterProbe({ published: recovered, probed: again.limits })).toBe(
      recovered,
    );
  });
});

const subscriptionAccount = {
  subscriptionType: "max",
  tokenSource: "oauth",
  apiProvider: undefined,
} as const;

/** A `get_usage` body that names one overage-included weekly bucket. */
function usageWithScopedBucket(displayName: string) {
  return {
    rate_limits_available: true as const,
    rate_limits: {
      five_hour: { utilization: 10, resets_at: null },
      ...({
        model_scoped: [{ display_name: displayName, utilization: 20, resets_at: null }],
      } as object),
    },
  };
}

describe("recordClaudeUsageResponse", () => {
  it("keeps the learned overage name when a later probe fails with a body", () => {
    const namesRef = Effect.runSync(makeClaudeScopedLimitNames);
    Effect.runSync(
      recordClaudeUsageResponse(namesRef, {
        checkedAt,
        account: subscriptionAccount,
        usage: usageWithScopedBucket("Fable"),
      }),
    );
    expect(Effect.runSync(Ref.get(namesRef))).toEqual({ overageIncluded: "Fable" });

    for (const usage of [
      { rate_limits_available: false, rate_limits: null },
      { rate_limits_available: true, rate_limits: null },
      undefined,
    ] as const) {
      const failed = Effect.runSync(
        recordClaudeUsageResponse(namesRef, {
          checkedAt,
          account: subscriptionAccount,
          usage,
        }),
      );
      expect(failed.unavailable?.reason).toBe("probeFailed");
      expect(Effect.runSync(Ref.get(namesRef))).toEqual({ overageIncluded: "Fable" });
    }

    expect(
      claudeRateLimitEventToUpdate(
        {
          status: "allowed",
          rateLimitType: "seven_day_overage_included" as never,
          utilization: 0.4,
        },
        Effect.runSync(Ref.get(namesRef)),
      )?.windows[0]?.id,
    ).toBe("seven_day_fable");
  });

  it("replaces the overage name when a later probe succeeds", () => {
    const namesRef = Effect.runSync(makeClaudeScopedLimitNames);
    Effect.runSync(Ref.set(namesRef, { overageIncluded: "Fable" }));
    Effect.runSync(
      recordClaudeUsageResponse(namesRef, {
        checkedAt,
        account: subscriptionAccount,
        usage: usageWithScopedBucket("Opus"),
      }),
    );
    expect(Effect.runSync(Ref.get(namesRef))).toEqual({ overageIncluded: "Opus" });
  });

  it("clears the overage name for an account that cannot report subscription windows", () => {
    const namesRef = Effect.runSync(makeClaudeScopedLimitNames);
    Effect.runSync(Ref.set(namesRef, { overageIncluded: "Fable" }));
    const limits = Effect.runSync(
      recordClaudeUsageResponse(namesRef, {
        checkedAt,
        account: { ...noAccount, tokenSource: "ANTHROPIC_AUTH_TOKEN" },
        usage: { rate_limits_available: false, rate_limits: null },
      }),
    );
    expect(limits.unavailable?.reason).toBe("unsupported");
    expect(Effect.runSync(Ref.get(namesRef))).toEqual({ overageIncluded: undefined });
  });
});

describe("claudeRateLimitEventToUpdate", () => {
  it("scales the 0–1 utilization and epoch-second reset onto the probe's window id", () => {
    expect(
      claudeRateLimitEventToUpdate(
        {
          status: "allowed_warning",
          rateLimitType: "seven_day",
          utilization: 0.85,
          resetsAt: 1_784_000_000,
        },
        noNames,
      ),
    ).toEqual({
      windows: [
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 85,
          windowDurationMins: 10080,
          resetsAt: "2026-07-14T03:33:20.000Z",
        },
      ],
    });
  });

  it("lands the streamed overage-included bucket on the row the probe named", () => {
    const event = {
      status: "allowed",
      rateLimitType: "seven_day_overage_included" as never,
      utilization: 0.4,
    } as const;
    // No probe has named the bucket yet: guessing would open a stray row.
    expect(claudeRateLimitEventToUpdate(event, noNames)).toBeUndefined();
    expect(claudeRateLimitEventToUpdate(event, { overageIncluded: "Fable" })).toEqual({
      windows: [
        {
          id: "seven_day_fable",
          kind: "weekly",
          label: "Weekly · Fable",
          usedPercent: 40,
          windowDurationMins: 10080,
        },
      ],
    });
  });

  it("ignores windows the page does not render and events without a utilization", () => {
    expect(
      claudeRateLimitEventToUpdate(
        { status: "allowed", rateLimitType: "seven_day_opus", utilization: 0.1 },
        noNames,
      ),
    ).toBeUndefined();
    expect(
      claudeRateLimitEventToUpdate({ status: "rejected", rateLimitType: "five_hour" }, noNames),
    ).toBeUndefined();
  });
});
