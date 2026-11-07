import { describe, expect, it } from "vite-plus/test";

import { resolvePlanFollowUpSubmission } from "./proposedPlan";

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
      text: "PLEASE IMPLEMENT THIS PLAN: Ship it",
      interactionMode: "default",
    });
  });

  it("falls back to a generic plan reference when the plan has no title", () => {
    expect(
      resolvePlanFollowUpSubmission({
        draftText: "",
        planMarkdown: "- step 1\n- step 2\n",
      }),
    ).toEqual({
      text: "PLEASE IMPLEMENT THIS PLAN: the proposed plan",
      interactionMode: "default",
    });
  });
});
