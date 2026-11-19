import * as Effect from "effect/Effect";
import { AcpRequestError } from "effect-acp/errors";
import { describe, expect, it } from "@effect/vitest";

import {
  mistralVibeAccountToUsageLimits,
  readMistralVibeUsageLimits,
} from "./mistralVibeUsageLimits.ts";

const checkedAt = "2026-11-19T10:00:00.000Z";

describe("mistralVibeAccountToUsageLimits", () => {
  it("maps the monthly Vibe Code budget to one monthly window", () => {
    expect(
      mistralVibeAccountToUsageLimits(
        {
          status: "active",
          plan: null,
          paygEnabled: false,
          budget: { usagePercentage: 42.5, resetAt: "2026-12-01T00:00:00Z" },
        },
        checkedAt,
      ),
    ).toEqual({
      checkedAt,
      windows: [
        {
          id: "monthly-budget",
          kind: "monthly",
          label: "Monthly Vibe Code budget",
          usedPercent: 42.5,
          resetsAt: "2026-12-01T00:00:00.000Z",
        },
      ],
    });
  });

  it("clamps usage past 100% (pay-as-you-go keeps billing)", () => {
    expect(
      mistralVibeAccountToUsageLimits({ budget: { usagePercentage: 130 } }, checkedAt)?.windows[0]
        ?.usedPercent,
    ).toBe(100);
  });

  it("omits resetsAt when the reset string does not parse", () => {
    const report = mistralVibeAccountToUsageLimits(
      { budget: { usagePercentage: 10, resetAt: "not a date" } },
      checkedAt,
    );
    expect(report?.windows[0]).not.toHaveProperty("resetsAt");
  });

  it("returns nothing when the budget is null or absent", () => {
    expect(mistralVibeAccountToUsageLimits({ budget: null }, checkedAt)).toBeUndefined();
    expect(mistralVibeAccountToUsageLimits({}, checkedAt)).toBeUndefined();
  });
});

describe("readMistralVibeUsageLimits", () => {
  it.effect("requests the account with the session id and reports the budget", () =>
    Effect.gen(function* () {
      const requests: Array<{ method: string; params: unknown }> = [];
      const reports: Array<unknown> = [];
      yield* readMistralVibeUsageLimits({
        runtime: {
          requestExt: (method, params) =>
            Effect.sync(() => {
              requests.push({ method, params });
              return { budget: { usagePercentage: 7 } };
            }),
        },
        sessionId: "session-1",
        onUsageLimits: (report) => Effect.sync(() => reports.push(report)),
      });
      expect(requests).toEqual([{ method: "_account/read", params: { sessionId: "session-1" } }]);
      expect(reports).toHaveLength(1);
    }),
  );

  it.effect("reports nothing and never fails when the request fails", () =>
    Effect.gen(function* () {
      const reports: Array<unknown> = [];
      yield* readMistralVibeUsageLimits({
        runtime: {
          requestExt: () =>
            Effect.fail(new AcpRequestError({ code: -32601, errorMessage: "method not found" })),
        },
        sessionId: "session-1",
        onUsageLimits: (report) => Effect.sync(() => reports.push(report)),
      });
      expect(reports).toEqual([]);
    }),
  );
});
