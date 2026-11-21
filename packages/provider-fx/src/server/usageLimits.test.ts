import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import { fxCreditsToLimits } from "./usageLimits.ts";

const checkedAt = "2026-11-21T16:00:00.000Z";
const limits = (credits: unknown) =>
  fxCreditsToLimits({
    credits: Option.some(typeof credits === "string" ? credits : JSON.stringify(credits)),
    checkedAt,
    team: "example-team",
  });
// `fx credits --json` from fx 0.0.17 (src/core/output/output_contracts.zig).
const credits = (tokenPass: unknown) => ({
  kind: "credits",
  balance: "9.731069815",
  used: "125.268930185",
  plan: null,
  token_pass: tokenPass,
});

describe("fx Token Pass limits", () => {
  it("reads the credit left of the $150 a pass refills to", () => {
    expect(
      limits(credits({ remaining: "79.92906", resets_at: "2026-12-05T08:00:00.000Z" })),
    ).toEqual({
      checkedAt,
      windows: [
        {
          id: "token_pass",
          kind: "monthly",
          label: "Token Pass",
          usedPercent: expect.closeTo(46.71, 2),
          resetsAt: "2026-12-05T08:00:00.000Z",
        },
      ],
      credentialFingerprint: "vercel-team:example-team",
    });
  });

  it.each([
    ["a used-up pass", { remaining: "0", resets_at: "2026-12-05T08:00:00.000Z" }, 100],
    ["an untouched pass", { remaining: "150", resets_at: "2026-12-05T08:00:00.000Z" }, 0],
    ["more credit than a pass refills to", { remaining: "180.5" }, 0],
  ])("reports %s", (_label, tokenPass, usedPercent) => {
    expect(limits(credits(tokenPass)).windows.map((window) => window.usedPercent)).toEqual([
      usedPercent,
    ]);
  });

  it("leaves out a reset time fx did not report and an account for an API key without a team", () => {
    const withoutTeam = fxCreditsToLimits({
      credits: Option.some(JSON.stringify(credits({ remaining: "5", resets_at: null }))),
      checkedAt,
      team: undefined,
    });
    expect(withoutTeam.windows[0]).not.toHaveProperty("resetsAt");
    expect(withoutTeam).not.toHaveProperty("credentialFingerprint");
  });

  it.each([
    ["a team without an active pass", credits(null)],
    ["an fx older than Token Pass", { kind: "credits", balance: "1", used: "2", plan: null }],
  ])("shows no limits for %s", (_label, output) => {
    expect(limits(output)).toEqual({
      checkedAt,
      windows: [],
      unavailable: { reason: "unsupported" },
    });
  });

  it.each([
    ["a credit AI Gateway could not read", credits({ remaining: null })],
    ["an amount that is not a number", credits({ remaining: "1.2.3" })],
    ["a credits error", { kind: "credits", error: "failed to fetch credits from gateway" }],
    ["output that is not JSON", "[credits] balance=1"],
  ])("keeps the earlier reading for %s", (_label, output) => {
    expect(limits(output).unavailable?.reason).toBe("probeFailed");
  });

  it("keeps the earlier reading when `fx credits` fails", () => {
    expect(
      fxCreditsToLimits({ credits: Option.none(), checkedAt, team: "example-team" }).unavailable,
    ).toEqual({ reason: "probeFailed", message: "fx could not read the Token Pass credit." });
  });
});
