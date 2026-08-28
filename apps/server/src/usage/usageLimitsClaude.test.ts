import { describe, expect, it } from "@effect/vitest";

import {
  claudePlanLabel,
  parseClaudeOauthCredentials,
  parseClaudeUsageWindows,
} from "./usageLimitsClaude.ts";

describe("parseClaudeOauthCredentials", () => {
  it("reads the CLI's credential document", () => {
    const parsed = parseClaudeOauthCredentials(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "sk-ant-oat01-abc",
          refreshToken: "sk-ant-ort01-def",
          expiresAt: 1_800_000_000_000,
          subscriptionType: "max",
        },
      }),
    );
    expect(parsed).toEqual({ accessToken: "sk-ant-oat01-abc", subscriptionType: "max" });
  });

  it("tolerates a missing subscription type", () => {
    const parsed = parseClaudeOauthCredentials(
      JSON.stringify({ claudeAiOauth: { accessToken: "token" } }),
    );
    expect(parsed).toEqual({ accessToken: "token", subscriptionType: null });
  });

  it("rejects documents without an OAuth grant", () => {
    expect(parseClaudeOauthCredentials("not json")).toBeNull();
    expect(parseClaudeOauthCredentials("{}")).toBeNull();
    expect(parseClaudeOauthCredentials(JSON.stringify({ claudeAiOauth: {} }))).toBeNull();
    expect(
      parseClaudeOauthCredentials(JSON.stringify({ claudeAiOauth: { accessToken: "  " } })),
    ).toBeNull();
  });
});

describe("claudePlanLabel", () => {
  it("maps known plans and humanises unknown ones", () => {
    expect(claudePlanLabel("max")).toBe("Claude Max");
    expect(claudePlanLabel("pro")).toBe("Claude Pro");
    expect(claudePlanLabel("supermax")).toBe("Claude Supermax");
    expect(claudePlanLabel(null)).toBeNull();
    expect(claudePlanLabel("  ")).toBeNull();
  });
});

describe("parseClaudeUsageWindows", () => {
  it("prefers the structured limits array, including model-scoped windows", () => {
    const windows = parseClaudeUsageWindows({
      five_hour: { utilization: 99, resets_at: "2026-08-12T18:00:00Z" },
      limits: [
        { kind: "session", percent: 12, resets_at: "2026-08-12T18:00:00+00:00", scope: null },
        { kind: "weekly_all", percent: 6, resets_at: "2026-08-18T00:59:59+00:00", scope: null },
        {
          kind: "weekly_scoped",
          percent: 10,
          resets_at: "2026-08-18T00:59:59+00:00",
          scope: { model: { id: null, display_name: "Fable" }, surface: null },
        },
      ],
    });
    expect(windows).toEqual([
      {
        id: "session",
        label: "Session limit",
        detail: "Rolling 5-hour window",
        utilization: 12,
        resetsAt: "2026-08-12T18:00:00+00:00",
      },
      {
        id: "weekly_all",
        label: "Weekly limit",
        detail: "All models · rolling 7-day window",
        utilization: 6,
        resetsAt: "2026-08-18T00:59:59+00:00",
      },
      {
        id: "weekly_scoped:Fable",
        label: "Weekly limit (Fable)",
        detail: "Rolling 7-day window",
        utilization: 10,
        resetsAt: "2026-08-18T00:59:59+00:00",
      },
    ]);
  });

  it("falls back to known legacy windows and drops codename slots", () => {
    const windows = parseClaudeUsageWindows({
      seven_day: { utilization: 34.5, resets_at: "2026-08-18T00:00:00+00:00" },
      five_hour: { utilization: -3, resets_at: "2026-08-12T18:00:00+00:00" },
      seven_day_opus: { utilization: 0, resets_at: null },
      nimbus_quill: { utilization: 0, resets_at: null },
      tangelo: null,
    });
    expect(windows.map((window) => window.id)).toEqual([
      "five_hour",
      "seven_day",
      "seven_day_opus",
    ]);
    expect(windows[0]?.utilization).toBe(0);
    expect(windows[2]?.resetsAt).toBeNull();
  });

  it("appends the extra-usage credit budget with money figures", () => {
    const windows = parseClaudeUsageWindows({
      limits: [{ kind: "session", percent: 1, resets_at: null, scope: null }],
      extra_usage: {
        is_enabled: false,
        monthly_limit: 5000,
        used_credits: 1944,
        utilization: 38.88,
        currency: "USD",
        decimal_places: 2,
      },
    });
    expect(windows.at(-1)).toEqual({
      id: "extra_usage",
      label: "Extra usage credits",
      detail: "$19.44 of $50.00 monthly usage credits",
      utilization: 38.88,
      resetsAt: null,
    });
  });

  it("omits an untouched, disabled extra-usage budget", () => {
    const windows = parseClaudeUsageWindows({
      limits: [{ kind: "session", percent: 1, resets_at: null, scope: null }],
      extra_usage: { is_enabled: false, utilization: 0 },
    });
    expect(windows.map((window) => window.id)).toEqual(["session"]);
  });

  it("returns empty for non-object documents", () => {
    expect(parseClaudeUsageWindows(null)).toEqual([]);
    expect(parseClaudeUsageWindows("nope")).toEqual([]);
  });
});
