import { describe, expect, it } from "@effect/vitest";

import { assessSandboxStart, type SandboxProviderLimits } from "./sandbox.ts";

const assess = (limits: Partial<SandboxProviderLimits>) =>
  assessSandboxStart({ canStart: true, ...limits }, { providerLabel: "Boat", nowMillis: 0 });

describe("assessSandboxStart", () => {
  it("asks for confirmation on paid, nearly exhausted, or last-slot starts without blocking", () => {
    const cases: ReadonlyArray<[Partial<SandboxProviderLimits>, ReadonlyArray<string>]> = [
      [{ startCost: "included" }, []],
      [{ startCost: "paid", startDollars: 0.03 }, ["This start will be charged about $0.03."]],
      // The threshold is ten percent of the window, but never below two starts.
      [
        { starts: [{ window: "minute", limit: 5, used: 3, remaining: 2 }] },
        ["Only 2 starts left this minute."],
      ],
      [{ starts: [{ window: "minute", limit: 5, used: 2, remaining: 3 }] }, []],
      [
        { starts: [{ window: "day", limit: 840, used: 756, remaining: 84 }] },
        ["Only 84 starts left this day."],
      ],
      [{ starts: [{ window: "day", limit: 840, used: 755, remaining: 85 }] }, []],
      [{ concurrency: { active: 1, max: 2 } }, ["This uses your last free slot (1 of 2 running)."]],
      // A full window that the provider still accepts is a paid start, not a refusal.
      [
        {
          startCost: "paid",
          starts: [{ window: "hour", limit: 60, used: 60, remaining: 0 }],
        },
        ["This start is past your plan's limits and will be charged."],
      ],
    ];
    for (const [limits, warnings] of cases) {
      expect(assess(limits)).toEqual({ blocked: null, warnings });
    }
  });
});
