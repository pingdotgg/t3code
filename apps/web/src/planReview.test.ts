import { describe, expect, it } from "vite-plus/test";

import {
  buildPlanReviewPrompt,
  buildPlanReviewThreadTitle,
  buildPlanRevisionPrompt,
} from "./planReview";

describe("plan review prompts", () => {
  const plan = "# Ship plan\n\n- Add the endpoint";

  it("builds a review title from the plan heading", () => {
    expect(buildPlanReviewThreadTitle(plan)).toBe("Review plan · Ship plan");
  });

  it("includes the plan and blocks implementation", () => {
    expect(
      buildPlanReviewPrompt({ planMarkdown: plan, instructions: "Find migration risks." }),
    ).toContain("Do not implement it or make any file changes.");
    expect(
      buildPlanReviewPrompt({ planMarkdown: plan, instructions: "Find migration risks." }),
    ).toContain("# Ship plan");
  });

  it("asks the original agent for a replacement plan", () => {
    expect(
      buildPlanRevisionPrompt({ planMarkdown: plan, reviewFeedback: "Add rollback." }),
    ).toContain("complete replacement proposed plan");
  });
});
