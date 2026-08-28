import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { codexPlanLabel, mapCodexRateLimits, parseCodexAuthKind } from "./usageLimitsCodex.ts";

describe("parseCodexAuthKind", () => {
  it("recognises a ChatGPT sign-in", () => {
    expect(
      parseCodexAuthKind(
        JSON.stringify({
          auth_mode: "chatgpt",
          OPENAI_API_KEY: null,
          tokens: { id_token: "a", access_token: "b", refresh_token: "c", account_id: "d" },
        }),
      ),
    ).toBe("chatgpt");
    expect(parseCodexAuthKind(JSON.stringify({ tokens: { access_token: "b" } }))).toBe("chatgpt");
  });

  it("recognises API-key auth", () => {
    expect(parseCodexAuthKind(JSON.stringify({ OPENAI_API_KEY: "sk-test" }))).toBe("apiKey");
  });

  it("treats everything else as signed out", () => {
    expect(parseCodexAuthKind("not json")).toBe("none");
    expect(parseCodexAuthKind("{}")).toBe("none");
    expect(parseCodexAuthKind(JSON.stringify({ OPENAI_API_KEY: "  " }))).toBe("none");
  });
});

describe("codexPlanLabel", () => {
  it("maps known plans and humanises unknown ones", () => {
    expect(codexPlanLabel("prolite")).toBe("ChatGPT Pro 5x");
    expect(codexPlanLabel("pro")).toBe("ChatGPT Pro 20x");
    expect(codexPlanLabel("plus")).toBe("ChatGPT Plus");
    expect(codexPlanLabel("unknown")).toBe("ChatGPT");
    expect(codexPlanLabel("megaplan")).toBe("ChatGPT Megaplan");
    expect(codexPlanLabel(null)).toBeNull();
  });
});

describe("mapCodexRateLimits", () => {
  // Shape observed live from `codex app-server` v0.147.0.
  const liveResponse = {
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 1_787_033_397 },
      secondary: null,
      credits: { hasCredits: false, unlimited: false, balance: "0" },
      spendControlReached: false,
      planType: "prolite",
      rateLimitReachedType: null,
    },
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        limitName: null,
        primary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 1_787_033_397 },
        secondary: null,
        planType: "prolite",
      },
      codex_bengalfox: {
        limitId: "codex_bengalfox",
        limitName: "GPT-5.3-Codex-Spark",
        primary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1_787_033_397 },
        secondary: null,
      },
    },
    rateLimitResetCredits: { availableCount: 0, credits: [] },
  };

  it("prefers the multi-bucket view and names scoped buckets", () => {
    const { windows, planType } = mapCodexRateLimits(liveResponse);
    expect(planType).toBe("prolite");
    expect(windows).toEqual([
      {
        id: "codex:primary",
        label: "Weekly limit",
        detail: "Rolling 7-day window",
        utilization: 10,
        resetsAt: DateTime.formatIso(DateTime.makeUnsafe(1_787_033_397 * 1000)),
      },
      {
        id: "codex_bengalfox:primary",
        label: "Weekly limit (GPT-5.3-Codex-Spark)",
        detail: "Rolling 7-day window",
        utilization: 0,
        resetsAt: DateTime.formatIso(DateTime.makeUnsafe(1_787_033_397 * 1000)),
      },
    ]);
  });

  it("falls back to the single-bucket view and titles session windows", () => {
    const { windows, planType } = mapCodexRateLimits({
      rateLimits: {
        primary: { usedPercent: 42.5, windowDurationMins: 300, resetsAt: 1_787_000_000 },
        secondary: { usedPercent: 8, windowDurationMins: 10080, resetsAt: null },
        planType: "plus",
      },
    });
    expect(planType).toBe("plus");
    expect(windows).toEqual([
      {
        id: "codex:primary",
        label: "Session limit",
        detail: "Rolling 5-hour window",
        utilization: 42.5,
        resetsAt: DateTime.formatIso(DateTime.makeUnsafe(1_787_000_000 * 1000)),
      },
      {
        id: "codex:secondary",
        label: "Weekly limit",
        detail: "Rolling 7-day window",
        utilization: 8,
        resetsAt: null,
      },
    ]);
  });

  it("returns empty for malformed documents", () => {
    expect(mapCodexRateLimits(null).windows).toEqual([]);
    expect(
      mapCodexRateLimits({ rateLimits: { primary: { usedPercent: "high" } } }).windows,
    ).toEqual([]);
  });
});
