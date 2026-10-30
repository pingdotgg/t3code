import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { exhaustedUsageWindow } from "@t3tools/shared/usageLimits";
import * as CodexErrors from "effect-codex-app-server/errors";
import type { V2GetAccountRateLimitsResponse__RateLimitSnapshot } from "effect-codex-app-server/schema";
import { describe, expect, it } from "vite-plus/test";

import {
  codexRateLimitsFailureMessage,
  codexRateLimitsToLimits,
  codexRateLimitsToUpdate,
  mergeCodexRateLimits,
} from "./codexUsageLimits.ts";

const checkedAt = "2026-07-18T10:00:00.000Z";

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

describe("Codex fallback routing", () => {
  it("keeps an account with spendable credits after its weekly allowance runs out", () => {
    const now = Date.parse(checkedAt);
    const exhaustedWeek = {
      limitId: "codex",
      planType: "plus",
      primary: { usedPercent: 12, resetsAt: 1_784_000_000, windowDurationMins: 300 },
      secondary: { usedPercent: 100, resetsAt: 1_784_500_000, windowDurationMins: 10080 },
    } satisfies V2GetAccountRateLimitsResponse__RateLimitSnapshot;
    const exhaustedWindow = (
      snapshot: V2GetAccountRateLimitsResponse__RateLimitSnapshot,
      topLevel: V2GetAccountRateLimitsResponse__RateLimitSnapshot = snapshot,
    ) =>
      exhaustedUsageWindow(
        {
          instanceId: ProviderInstanceId.make("codex"),
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          installed: true,
          version: null,
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt,
          models: [],
          slashCommands: [],
          skills: [],
          usageLimits: codexRateLimitsToLimits({
            checkedAt,
            snapshot: topLevel,
            rateLimitsByLimitId: { codex: snapshot },
          }),
        } satisfies ServerProvider,
        now,
        "gpt-6-luna",
      );
    const credits = { hasCredits: true, unlimited: false, balance: "42.50" };

    expect(exhaustedWindow({ ...exhaustedWeek, credits: null })?.id).toBe("secondary");
    expect(
      exhaustedWindow({
        ...exhaustedWeek,
        credits: { hasCredits: false, unlimited: false, balance: "0" },
      })?.id,
    ).toBe("secondary");
    expect(exhaustedWindow({ ...exhaustedWeek, credits, spendControlReached: true })?.id).toBe(
      "secondary",
    );
    expect(
      exhaustedWindow({ ...exhaustedWeek, credits, spendControlReached: false }),
      "weekly allowance used up but credits remain spendable",
    ).toBeUndefined();
    expect(
      exhaustedWindow({
        ...exhaustedWeek,
        credits: { hasCredits: false, unlimited: true },
        spendControlReached: false,
      }),
      "weekly allowance used up but credits are unlimited",
    ).toBeUndefined();
    for (const rateLimitReachedType of [
      "workspace_owner_credits_depleted",
      "workspace_member_credits_depleted",
      "workspace_owner_usage_limit_reached",
      "workspace_member_usage_limit_reached",
    ] as const) {
      expect(
        exhaustedWindow({
          ...exhaustedWeek,
          credits,
          spendControlReached: null,
          rateLimitReachedType,
        })?.id,
        rateLimitReachedType,
      ).toBe("secondary");
    }
    expect(
      exhaustedWindow({
        ...exhaustedWeek,
        secondary: { ...exhaustedWeek.secondary, usedPercent: 40 },
        individualLimit: { limit: "50", used: "50", remainingPercent: 0, resetsAt: 1_784_500_000 },
        credits,
        spendControlReached: null,
      })?.id,
      "monthly credit limit used up",
    ).toBe("individual");
    expect(
      exhaustedWindow(exhaustedWeek, { ...exhaustedWeek, credits, spendControlReached: null }),
      "credits reported only on the top-level snapshot",
    ).toBeUndefined();
  });
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

  it("states credit eligibility only when a notification changes it", () => {
    const credits = { hasCredits: true, unlimited: false };
    const eligible = { secondary: { usedPercent: 100, windowDurationMins: 10080 }, credits };
    expect(codexRateLimitsToUpdate(eligible)?.continuesOnCredits).toBe(true);
    expect(codexRateLimitsToUpdate(structuredClone(eligible), eligible)).toBeUndefined();
    expect(codexRateLimitsToUpdate({ spendControlReached: true }, eligible)).toEqual({
      windows: [],
      continuesOnCredits: false,
    });
    expect(
      codexRateLimitsToUpdate(
        { rateLimitReachedType: "workspace_member_usage_limit_reached" },
        eligible,
      )?.continuesOnCredits,
    ).toBe(false);
    expect(
      codexRateLimitsToUpdate({ credits: { hasCredits: false, unlimited: false } }, eligible)
        ?.continuesOnCredits,
    ).toBe(false);
    expect(codexRateLimitsToUpdate({ spendControlReached: false }, eligible)).toBeUndefined();
    expect(
      codexRateLimitsToUpdate({ secondary: { usedPercent: 100, windowDurationMins: 10080 } }),
    ).not.toHaveProperty("continuesOnCredits");
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
