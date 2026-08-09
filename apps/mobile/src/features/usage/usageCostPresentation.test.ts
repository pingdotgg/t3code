import { describe, expect, it } from "vite-plus/test";

import { presentUsageCost, presentUsageCostShare } from "./usageCostPresentation";

describe("presentUsageCost", () => {
  it("does not present fully unpriced mobile usage as free", () => {
    const cost = presentUsageCost(0, 1, 0);

    expect(cost).toEqual({
      amount: "—",
      headline: "—",
      headlineDetail: "No matching API rates; token totals are still complete.",
      chartLabel: "Raw token cost (partial)",
      costShare: "—",
      unpricedDetail: "100.0% unpriced",
      hasUnpriced: true,
    });
    expect(presentUsageCostShare(cost, 0.5)).toBe("No priced-cost share · 100.0% unpriced");
  });

  it("marks mixed mobile usage as a lower-bound priced-cost estimate", () => {
    const cost = presentUsageCost(12.34, 0.25, 0.4);

    expect(cost).toEqual({
      amount: "≥$12.34",
      headline: "≥$12.34*",
      headlineDetail: "* Partial API-rate estimate; 25.0% of requests have no matching rate.",
      chartLabel: "Raw token cost (partial)",
      costShare: "40.0%",
      unpricedDetail: "25.0% unpriced",
      hasUnpriced: true,
    });
    expect(presentUsageCostShare(cost, 0.5)).toBe("40.0% of priced cost · 25.0% unpriced");
  });

  it("preserves the existing mobile wording when every request is priced", () => {
    const cost = presentUsageCost(12.34, 0, 0.4);

    expect(cost).toEqual({
      amount: "$12.34",
      headline: "$12.34*",
      headlineDetail: "* if billed at full API rate",
      chartLabel: "Raw token cost",
      costShare: "40.0%",
      unpricedDetail: null,
      hasUnpriced: false,
    });
    expect(presentUsageCostShare(cost, 0)).toBe("40.0% of cost");
  });
});
