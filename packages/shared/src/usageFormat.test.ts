import { describe, expect, it } from "vite-plus/test";

import { formatCostEstimate } from "./usageFormat.js";

describe("formatCostEstimate", () => {
  it("does not present fully unpriced usage as zero cost", () => {
    expect(formatCostEstimate(0, 1)).toEqual({
      value: "—",
      detail: "No matching API rates; token totals are still complete.",
    });
  });

  it("marks a mixed priced and unpriced total as a lower bound", () => {
    expect(formatCostEstimate(12.34, 0.25)).toEqual({
      value: "≥$12.34",
      detail: "Partial API-rate estimate; 25.0% of requests have no matching rate.",
    });
  });

  it("keeps the existing API-rate label when every request is priced", () => {
    expect(formatCostEstimate(12.34, 0)).toEqual({
      value: "$12.34",
      detail: "If billed at full API rate.",
    });
  });
});
