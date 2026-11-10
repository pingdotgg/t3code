import { describe, expect, it } from "vite-plus/test";

import { resolveStepIds, slugifyStepName, uniqueStepId } from "./pipelineStepIds.ts";

const step = (name: string, lockedId: string | null = null) => ({ name, lockedId });

describe("step ids", () => {
  it("slugifies names and numbers duplicates", () => {
    for (const [name, slug] of [
      ["  Plan the Work! ", "plan-the-work"],
      ["  Review & Fix! ", "review-fix"],
      ["日本語", "step"],
      ["!!!", "step"],
      ["a".repeat(60), "a".repeat(48)],
    ] as const) {
      expect(slugifyStepName(name)).toBe(slug);
    }
    expect(uniqueStepId("review", new Set(["review", "review-2"]))).toBe("review-3");
    expect(uniqueStepId("a".repeat(48), new Set(["a".repeat(48)]))).toBe(`${"a".repeat(46)}-2`);

    expect(resolveStepIds([step("Plan"), step("Review"), step("review!")])).toEqual([
      "plan",
      "review",
      "review-2",
    ]);
  });

  it("keeps saved ids when a step is renamed and never reuses them for new steps", () => {
    expect(resolveStepIds([step("Renamed", "review"), step("Review")])).toEqual([
      "review",
      "review-2",
    ]);
  });
});
