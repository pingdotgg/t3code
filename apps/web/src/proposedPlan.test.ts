import { describe, expect, it } from "vite-plus/test";

import { buildCollapsedProposedPlanPreview, resolvePlanFollowUpSubmission } from "./proposedPlan";
import {
  createAssistantTextSelector,
  findAssistantCitationText,
} from "./lib/assistantTextSelection";

describe("proposed plan preview citations", () => {
  it("resolves repeated text at the preview boundary after expansion", () => {
    const quote = "Repeatable health check.";
    const planMarkdown = `Check remote.\n${quote}\nExtended acceptance.\n${quote}`;
    const { markdown: preview } = buildCollapsedProposedPlanPreview(planMarkdown, { maxLines: 2 });
    const start = preview.indexOf(quote);
    const citation = createAssistantTextSelector(preview, start, start + quote.length)!;

    expect(findAssistantCitationText(planMarkdown, citation)).toEqual({
      start,
      end: start + quote.length,
    });
  });
});

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
