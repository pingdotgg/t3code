import { ServerProviderUsageLimits } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as CodexErrors from "effect-codex-app-server/errors";
import { describe, expect, it } from "vite-plus/test";

import {
  codexRateLimitsFailureMessage,
  codexRateLimitsToLimits,
  codexRateLimitsToUpdate,
  codexResetCreditsToContract,
  codexUsageLimitMessage,
  mergeCodexRateLimits,
} from "./codexUsageLimits.ts";

const checkedAt = "2026-07-18T10:00:00.000Z";
const decodeUsageLimitsForPermission = Schema.decodeSync(ServerProviderUsageLimits);
const decodeUnknownUsageLimitsForSpend = Schema.decodeUnknownSync(ServerProviderUsageLimits);

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

  it("selects the main Codex allowance and leaves Spark out", () => {
    const spark = {
      limitId: "codex_bengalfox",
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

  it("does not show a model-specific legacy snapshot as the main allowance", () => {
    expect(
      codexRateLimitsToLimits({
        checkedAt,
        snapshot: {
          limitId: "codex_bengalfox",
          secondary: { usedPercent: 90 },
        },
      }).windows,
    ).toEqual([]);
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

  it("ignores Spark notifications so they cannot overwrite the main allowance", () => {
    expect(
      codexRateLimitsToUpdate({
        limitId: "codex_bengalfox",
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

  it("phrases a dead process differently from a bad answer", () => {
    expect(
      codexRateLimitsFailureMessage(new CodexErrors.CodexAppServerProcessExitedError({ code: 1 })),
    ).toBe("Codex exited before it could report usage.");
  });
});

describe("codexResetCreditsToContract", () => {
  it("counts available credits and reports the soonest expiry", () => {
    expect(
      codexResetCreditsToContract({
        availableCount: 2,
        credits: [
          { status: "available", expiresAt: 1_784_500_000 },
          { status: "redeemed", expiresAt: 1_700_000_000 },
          { status: "available", expiresAt: 1_784_000_000 },
        ],
      }),
    ).toEqual({ availableCount: 2, nextExpiresAt: "2026-07-14T03:33:20.000Z" });
    expect(codexResetCreditsToContract({ availableCount: 0 })).toEqual({ availableCount: 0 });
    expect(codexResetCreditsToContract(null)).toBeUndefined();
  });

  it("rides along on the probe's limits", () => {
    expect(
      codexRateLimitsToLimits({
        checkedAt,
        snapshot: { primary: { usedPercent: 5, windowDurationMins: 300 } },
        resetCredits: { availableCount: 1 },
      }).resetCredits,
    ).toEqual({ availableCount: 1 });
  });
});

describe("codexUsageLimitMessage", () => {
  const at = "2026-01-01T00:00:00.000Z";
  const atSeconds = Date.parse(at) / 1000;

  it("names the exhausted window and the workspace's missing credits", () => {
    expect(
      codexUsageLimitMessage(
        {
          limitId: "codex",
          rateLimitReachedType: "workspace_owner_credits_depleted",
          primary: { usedPercent: 40, resetsAt: atSeconds + 3_600, windowDurationMins: 300 },
          secondary: {
            usedPercent: 100,
            resetsAt: atSeconds + 5 * 86_400 + 5 * 3_600,
            windowDurationMins: 10_080,
          },
        },
        at,
      ),
    ).toBe(
      "Codex usage limit reached. The weekly limit resets in 5d 5h. The workspace has no credits to continue sooner: ask your workspace owner to add credits, or send the message again once the limit resets.",
    );
  });

  it("points a reached spend cap at the workspace owner", () => {
    expect(
      codexUsageLimitMessage(
        {
          limitId: "codex",
          rateLimitReachedType: "workspace_member_usage_limit_reached",
          primary: {
            usedPercent: 100,
            resetsAt: atSeconds + 3 * 3_600 + 20 * 60,
            windowDurationMins: 300,
          },
        },
        at,
      ),
    ).toBe(
      "Codex usage limit reached. The session limit resets in 3h 20m. The workspace spend limit is reached: ask your workspace owner to raise it, or send the message again once the limit resets.",
    );
  });

  it("names no window when credits run out without one", () => {
    expect(
      codexUsageLimitMessage(
        { limitId: "codex", rateLimitReachedType: "workspace_member_credits_depleted" },
        at,
      ),
    ).toBe(
      "Codex usage limit reached. The workspace has no credits to continue sooner: ask your workspace owner to add credits, or send the message again once the limit resets.",
    );
  });

  it("says only what it knows without a snapshot", () => {
    expect(codexUsageLimitMessage(undefined, at)).toBe(
      "Codex usage limit reached. Send the message again once the limit resets.",
    );
  });
});

describe("mergeCodexRateLimits", () => {
  it("keeps windows an update does not carry", () => {
    const merged = mergeCodexRateLimits(
      {
        limitId: "codex",
        planType: "business",
        primary: { usedPercent: 100, resetsAt: 1_800_000_000, windowDurationMins: 300 },
      },
      { rateLimitReachedType: "rate_limit_reached" },
    );

    expect(merged).toEqual({
      limitId: "codex",
      planType: "business",
      rateLimitReachedType: "rate_limit_reached",
      primary: { usedPercent: 100, resetsAt: 1_800_000_000, windowDurationMins: 300 },
    });
  });

  it("ignores a model-specific snapshot so it cannot replace the main allowance", () => {
    const main = {
      limitId: "codex",
      primary: { usedPercent: 100, resetsAt: 1_800_000_000, windowDurationMins: 300 },
    };
    expect(
      mergeCodexRateLimits(main, {
        limitId: "spark",
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

describe("native included-use permission", () => {
  it.each([false, null, true])(
    "preserves permission %s and its probe time through the public schema",
    (ordinaryUsageAllowed) => {
      const result = codexRateLimitsToLimits({
        checkedAt,
        ordinaryUsageAllowed,
        snapshot: {
          primary: { usedPercent: 1 },
          rateLimitReachedType: "workspace_member_usage_limit_reached",
        },
        resetCredits: { availableCount: 4 },
      });
      const decoded = decodeUsageLimitsForPermission(result);
      expect(decoded).toMatchObject({
        ordinaryUsageAllowed,
        ordinaryUsageCheckedAt: checkedAt,
        rateLimitReachedType: "workspace_member_usage_limit_reached",
      });
      expect(decoded.windows[0]?.usedPercent).toBe(1);
    },
  );
  it("does not invent permission when an older response omits it", () => {
    expect(
      codexRateLimitsToLimits({ checkedAt, snapshot: { primary: { usedPercent: 1 } } }),
    ).not.toHaveProperty("ordinaryUsageAllowed");
  });
  it("selects denial metadata from the main bucket", () => {
    expect(
      codexRateLimitsToLimits({
        checkedAt,
        snapshot: { limitId: "spark", rateLimitReachedType: "other_limit" },
        rateLimitsByLimitId: {
          codex: {
            primary: { usedPercent: 1 },
            rateLimitReachedType: "workspace_member_usage_limit_reached",
          },
        },
      }),
    ).toMatchObject({ rateLimitReachedType: "workspace_member_usage_limit_reached" });
  });
  it.each(["workspace_member_usage_limit_reached", null])(
    "publishes a denial-only or explicit clearing update: %s",
    (rateLimitReachedType) => {
      expect(codexRateLimitsToUpdate({ rateLimitReachedType })).toEqual({
        windows: [],
        rateLimitReachedType,
      });
    },
  );
  it("does not publish another model's denial as the main allowance", () => {
    expect(
      codexRateLimitsToUpdate({ limitId: "spark", rateLimitReachedType: "other_limit" }),
    ).toBeUndefined();
    expect(
      codexRateLimitsToLimits({
        checkedAt,
        snapshot: { limitId: "spark", rateLimitReachedType: "other_limit" },
      }),
    ).not.toHaveProperty("rateLimitReachedType");
  });
});

describe("main spend-control denial", () => {
  it.each([true, false, null])(
    "preserves %s through the mapper and public schema",
    (spendControlReached) => {
      const snapshot = {
        limitId: "codex",
        spendControlReached,
        rateLimitReachedType: null,
        primary: { usedPercent: 1, windowDurationMins: 300 },
      };
      const result = codexRateLimitsToLimits({
        checkedAt,
        ordinaryUsageAllowed: true,
        snapshot,
        resetCredits: { availableCount: 4 },
      });
      expect(decodeUsageLimitsForPermission(result)).toMatchObject({
        spendControlReached,
        ordinaryUsageAllowed: true,
        ordinaryUsageCheckedAt: checkedAt,
      });
    },
  );
  it("does not invent a spend-control negative for a missing field", () => {
    expect(
      codexRateLimitsToLimits({
        checkedAt,
        ordinaryUsageAllowed: true,
        snapshot: { limitId: "codex", primary: { usedPercent: 1 } },
      }),
    ).not.toHaveProperty("spendControlReached");
  });
  it("rejects malformed spend-control metadata through the public schema", () => {
    const result = codexRateLimitsToLimits({
      checkedAt,
      snapshot: { primary: { usedPercent: 1 } },
    });
    for (const spendControlReached of [1, "false", []]) {
      expect(() => decodeUnknownUsageLimitsForSpend({ ...result, spendControlReached })).toThrow();
    }
  });
  it.each([true, false, null])(
    "publishes spend-control-only notification %s",
    (spendControlReached) => {
      const update = { limitId: "codex", spendControlReached };
      expect(codexRateLimitsToUpdate(update)).toEqual({ windows: [], spendControlReached });
    },
  );
  it("does not import another model's spend control", () => {
    const other = { limitId: "spark", spendControlReached: true };
    expect(codexRateLimitsToUpdate(other)).toBeUndefined();
    expect(codexRateLimitsToLimits({ checkedAt, snapshot: other })).not.toHaveProperty(
      "spendControlReached",
    );
    const main = { limitId: "codex", spendControlReached: false };
    expect(
      codexRateLimitsToLimits({
        checkedAt,
        snapshot: other,
        rateLimitsByLimitId: { codex: main, spark: other },
      }),
    ).toMatchObject({ spendControlReached: false });
  });
  it("retains omitted spend control and truthfully replaces it with explicit false or null", () => {
    const previous = { limitId: "codex", spendControlReached: true, primary: { usedPercent: 1 } };
    expect(mergeCodexRateLimits(previous, { secondary: { usedPercent: 2 } })).toMatchObject({
      spendControlReached: true,
    });
    for (const spendControlReached of [false, null]) {
      const update = { limitId: "codex", spendControlReached };
      expect(mergeCodexRateLimits(previous, update)).toMatchObject({ spendControlReached });
    }
  });
});
