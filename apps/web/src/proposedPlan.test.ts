import { describe, expect, it } from "vite-plus/test";

import { proposedPlanStepCount, resolvePlanFollowUpSubmission } from "./proposedPlan";

describe("resolvePlanFollowUpSubmission", () => {
  it.each(["", "Consider this "])(
    "keeps context-bearing feedback in plan mode with prose %j",
    (prose) => {
      const draftText = `${prose}[PR #42](t3-context://v1/review-comment/pr-42)`;
      expect(resolvePlanFollowUpSubmission({ draftText, planMarkdown: "# Plan" })).toEqual({
        text: draftText,
        interactionMode: "plan",
      });
    },
  );
  it("switches to default mode when implementing the ready plan without extra text", () => {
    expect(
      resolvePlanFollowUpSubmission({
        draftText: "   ",
        planMarkdown: "## Ship it\n\n- step 1\n",
      }),
    ).toEqual({
      text: "PLEASE IMPLEMENT THIS PLAN:\n## Ship it\n\n- step 1",
      interactionMode: "default",
    });
  });
});

describe("proposedPlanStepCount", () => {
  it("counts top-level numbered steps outside code fences", () => {
    expect(
      proposedPlanStepCount(
        [
          "# Plan",
          "1. Move the strip",
          "   1. nested detail",
          "2. Drop the chip",
          "```",
          "3. not a step",
          "```",
          "- bullet",
          "3) Update settings",
        ].join("\n"),
      ),
    ).toBe(3);
    expect(proposedPlanStepCount("# Plan\n- only bullets")).toBe(0);
  });
});
