import { describe, expect, it } from "vite-plus/test";

import { buildPlanImplementationPrompt } from "./proposedPlan";

describe("buildPlanImplementationPrompt", () => {
  it("uses the plan title when present", () => {
    expect(buildPlanImplementationPrompt("## Ship it\n\n- step 1\n")).toBe(
      "PLEASE IMPLEMENT THIS PLAN: Ship it",
    );
  });

  it("falls back to a generic plan reference when the plan has no title", () => {
    expect(buildPlanImplementationPrompt("- step 1\n- step 2\n")).toBe(
      "PLEASE IMPLEMENT THIS PLAN: the proposed plan",
    );
  });
});
