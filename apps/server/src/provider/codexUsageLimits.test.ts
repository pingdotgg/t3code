import * as CodexErrors from "effect-codex-app-server/errors";
import { describe, expect, it } from "vite-plus/test";

import {
  canAutoRedeemCodexReset,
  confirmsCodexResetCredit,
  codexRateLimitsFailureMessage,
  codexRateLimitsToLimits,
  codexRateLimitsToUpdate,
  mergeCodexRateLimits,
} from "./codexUsageLimits.ts";

const checkedAt = "2026-07-18T10:00:00.000Z";

describe("automatic Codex reset checks", () => {
  const limits = {
    checkedAt,
    windows: [],
    credentialFingerprint: "account-fingerprint",
    resetCredits: { availableCount: 1 },
  } as const;

  it("requires the same account, a newer probe, an available credit and an exhausted window", () => {
    const eligible = {
      mode: "first" as const,
      initialFingerprint: "account-fingerprint",
      freshFingerprint: "account-fingerprint",
      checkedBefore: "2026-07-18T09:59:00.000Z",
      limits,
      creditsAvailable: 1,
      usageExhausted: true,
    };
    expect(canAutoRedeemCodexReset(eligible)).toBe(true);
    expect(canAutoRedeemCodexReset({ ...eligible, freshFingerprint: "other-account" })).toBe(false);
    expect(canAutoRedeemCodexReset({ ...eligible, checkedBefore: checkedAt })).toBe(false);
    expect(canAutoRedeemCodexReset({ ...eligible, creditsAvailable: 0 })).toBe(false);
    expect(canAutoRedeemCodexReset({ ...eligible, usageExhausted: false })).toBe(false);
    expect(
      canAutoRedeemCodexReset({
        ...eligible,
        mode: "replay",
        creditsAvailable: 0,
        usageExhausted: false,
      }),
    ).toBe(true);
    expect(
      canAutoRedeemCodexReset({
        ...eligible,
        limits: { ...limits, unavailable: { reason: "probeFailed" } },
      }),
    ).toBe(false);
  });

  it("confirms only a reset outcome with a newer, available probe and cleared limits", () => {
    const confirmed = {
      outcome: "reset" as const,
      checkedBefore: "2026-07-18T09:59:00.000Z",
      checkedAt,
      limitsUnavailable: false,
      usageExhausted: false,
    };
    expect(confirmsCodexResetCredit(confirmed)).toBe(true);
    expect(confirmsCodexResetCredit({ ...confirmed, outcome: "alreadyRedeemed" })).toBe(true);
    expect(confirmsCodexResetCredit({ ...confirmed, outcome: "noCredit" })).toBe(false);
    expect(confirmsCodexResetCredit({ ...confirmed, checkedAt: confirmed.checkedBefore })).toBe(
      false,
    );
    expect(confirmsCodexResetCredit({ ...confirmed, limitsUnavailable: true })).toBe(false);
    expect(confirmsCodexResetCredit({ ...confirmed, usageExhausted: true })).toBe(false);
  });
});

describe("codexRateLimitsToLimits", () => {
  it("shows an Enterprise monthly credit allowance in reads and notifications without a duration", () => {
    const snapshot = {
      limitId: "codex",
      planType: "enterprise_cbp_usage_based",
      primary: null,
      secondary: null,
      individualLimit: { remainingPercent: 99, resetsAt: 1_784_500_000 },
    };
    const windows = [
      {
        id: "individual",
        kind: "monthly",
        label: "Monthly credit limit",
        usedPercent: 1,
        resetsAt: "2026-07-19T22:26:40.000Z",
      },
    ];

    expect(
      codexRateLimitsToLimits({
        checkedAt,
        snapshot: { limitId: "spark" },
        rateLimitsByLimitId: { codex: snapshot },
      }),
    ).toEqual({ checkedAt, windows });
    expect(codexRateLimitsToUpdate(snapshot)).toEqual({ windows });
  });

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

  it("reports the next available reset credit and credential fingerprint", () => {
    expect(
      codexRateLimitsToLimits({
        checkedAt,
        snapshot: { planType: "plus" },
        resetCredits: {
          availableCount: 2,
          credits: [
            { id: "later", grantedAt: 10, status: "available", expiresAt: 500 },
            { id: "earlier", grantedAt: 5, status: "available", expiresAt: 300 },
            { id: "used", grantedAt: 1, status: "redeemed", expiresAt: 100 },
          ],
        },
        credentialFingerprint: "account-fingerprint",
      }),
    ).toEqual({
      checkedAt,
      windows: [],
      credentialFingerprint: "account-fingerprint",
      resetCredits: {
        availableCount: 2,
        nextCreditId: "later",
        nextExpiresAt: "1970-01-01T00:05:00.000Z",
      },
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

  it("selects the main Codex allowance and leaves Spark out", () => {
    const spark = {
      limitId: "codex_bengalfox",
      individualLimit: { remainingPercent: 99, resetsAt: 1_784_500_000 },
      primary: { usedPercent: 0, windowDurationMins: 300 },
      secondary: { usedPercent: 90, windowDurationMins: 10080 },
    };
    expect(
      codexRateLimitsToLimits({
        checkedAt,
        snapshot: spark,
        rateLimitsByLimitId: {
          codex_bengalfox: spark,
          codex: { secondary: { usedPercent: 42, windowDurationMins: 10080 } },
        },
      }).windows,
    ).toEqual([
      {
        id: "secondary",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 42,
        windowDurationMins: 10080,
      },
    ]);
  });

  it.each([undefined, null, {}])(
    "supports legacy reads with no bucket map: %j",
    (rateLimitsByLimitId) => {
      const snapshot = { primary: { usedPercent: 12, windowDurationMins: 300 } };
      expect(codexRateLimitsToLimits({ checkedAt, snapshot, rateLimitsByLimitId })).toEqual(
        codexRateLimitsToLimits({ checkedAt, snapshot }),
      );
    },
  );
});

describe("codexRateLimitsToUpdate", () => {
  it("does not republish cached windows over a newer account probe", () => {
    const cached = {
      primary: { usedPercent: 0, resetsAt: 1_784_000_000, windowDurationMins: 300 },
      secondary: { usedPercent: 20, resetsAt: 1_784_500_000, windowDurationMins: 10080 },
    };
    expect(codexRateLimitsToUpdate(cached)?.windows).toHaveLength(2);
    expect(codexRateLimitsToUpdate(structuredClone(cached), cached)).toBeUndefined();

    const changed = { ...cached, secondary: { ...cached.secondary, usedPercent: 21 } };
    expect(codexRateLimitsToUpdate(changed, cached)?.windows.map((window) => window.id)).toEqual([
      "secondary",
    ]);
    expect(codexRateLimitsToUpdate({ primary: cached.primary }, cached)).toBeUndefined();
    expect(
      codexRateLimitsToUpdate({ primary: { ...cached.primary, resetsAt: 1_784_001_000 } }, cached)
        ?.windows,
    ).toHaveLength(1);
    expect(
      codexRateLimitsToUpdate({ primary: { ...cached.primary, usedPercent: 76 } }, cached)
        ?.windows[0]?.usedPercent,
    ).toBe(76);
  });

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

  it("ignores Spark notifications so they cannot overwrite the main allowance", () => {
    expect(
      codexRateLimitsToUpdate({
        limitId: "codex_bengalfox",
        individualLimit: { remainingPercent: 99, resetsAt: 1_784_500_000 },
        primary: { usedPercent: 0, windowDurationMins: 300 },
        secondary: { usedPercent: 90, windowDurationMins: 10080 },
      }),
    ).toBeUndefined();
    expect(
      codexRateLimitsToUpdate({
        limitId: "codex",
        secondary: { usedPercent: 42, windowDurationMins: 10080 },
      })?.windows,
    ).toEqual([
      {
        id: "secondary",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 42,
        windowDurationMins: 10080,
      },
    ]);
  });
});

describe("codexRateLimitsFailureMessage", () => {
  it("keeps the JSON-RPC code and nothing else from a request failure", () => {
    expect(
      codexRateLimitsFailureMessage(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage:
            "failed to fetch codex rate limits: GET https://chatgpt.com/backend-api/wham/usage failed: 401 Unauthorized",
        }),
      ),
    ).toBe("Codex could not read usage (JSON-RPC -32603).");
  });
});

describe("mergeCodexRateLimits", () => {
  it("updates monthly credit usage, retains it when omitted, and clears an explicit null", () => {
    const snapshot = {
      limitId: "codex",
      primary: { usedPercent: 12 },
      individualLimit: { remainingPercent: 99, resetsAt: 1_784_500_000 },
    };
    const individualLimit = { remainingPercent: 75, resetsAt: 1_787_000_000 };
    const changed = mergeCodexRateLimits(snapshot, { individualLimit });
    expect(changed).toEqual({ ...snapshot, individualLimit });
    expect(codexRateLimitsToUpdate(changed!)).toEqual({
      windows: [
        {
          id: "primary",
          kind: "session",
          label: "Session",
          usedPercent: 12,
          windowDurationMins: 300,
        },
        {
          id: "individual",
          kind: "monthly",
          label: "Monthly credit limit",
          usedPercent: 25,
          resetsAt: "2026-08-17T20:53:20.000Z",
        },
      ],
    });

    const retained = mergeCodexRateLimits(changed, { primary: null });
    expect(retained).toEqual({ ...snapshot, primary: null, individualLimit });
    const cleared = mergeCodexRateLimits(retained, { individualLimit: null });
    expect(cleared).toEqual({ ...snapshot, primary: null, individualLimit: null });
    expect(codexRateLimitsToLimits({ checkedAt, snapshot: cleared! }).windows).toEqual([]);
  });

  it("ignores a model-specific snapshot so it cannot replace the main allowance", () => {
    const main = {
      limitId: "codex",
      primary: { usedPercent: 100, resetsAt: 1_800_000_000, windowDurationMins: 300 },
    };
    expect(
      mergeCodexRateLimits(main, {
        limitId: "spark",
        individualLimit: { remainingPercent: 99, resetsAt: 1_784_500_000 },
        primary: { usedPercent: 3, resetsAt: 1_800_000_000, windowDurationMins: 300 },
      }),
    ).toBe(main);
  });
});

import { codexUsageLimitResetAt } from "./codexUsageLimits.ts";

describe("codexUsageLimitResetAt", () => {
  it("waits for every exhausted window and never invents an unknown reset", () => {
    expect(
      codexUsageLimitResetAt({
        primary: { usedPercent: 100, resetsAt: 2000000000 },
        secondary: { usedPercent: 100, resetsAt: 2000100000 },
      }),
    ).toBe("2033-05-19T07:20:00.000Z");
    expect(codexUsageLimitResetAt({ primary: { usedPercent: 100 } })).toBeNull();
    expect(
      codexUsageLimitResetAt({ primary: { usedPercent: 50, resetsAt: 2000000000 } }),
    ).toBeNull();
  });
});
