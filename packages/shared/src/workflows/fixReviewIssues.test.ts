import { DEFAULT_FIX_REVIEW_ISSUES_PROMPT_TEMPLATE } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { buildFixReviewIssuesPrompt } from "./fixReviewIssues.ts";

describe("buildFixReviewIssuesPrompt", () => {
  it("includes the configured instructions and every formatted issue", () => {
    const issues = `1. [P1] First issue
src/first.ts:10

First issue details.

2. [P2] Second issue
src/second.ts:20

Second issue details.`;
    const prompt = buildFixReviewIssuesPrompt({
      issues,
      settings: { promptTemplate: "Validate the findings, fix valid ones, and create a PR." },
    });

    expect(prompt).toContain("Validate the findings, fix valid ones, and create a PR.");
    expect(prompt).toContain(issues);
  });

  it("falls back to the default instructions when the configured prompt is blank", () => {
    const prompt = buildFixReviewIssuesPrompt({
      issues: "[P1] An issue",
      settings: { promptTemplate: "   " },
    });

    expect(prompt).toContain(DEFAULT_FIX_REVIEW_ISSUES_PROMPT_TEMPLATE);
    expect(prompt).toContain("commit and push the fixes to update that pull request");
    expect(prompt).toContain("do not create a new pull request");
  });

  it("identifies the pull request that must be updated", () => {
    const prompt = buildFixReviewIssuesPrompt({
      issues: "[P1] An issue",
      pullRequestNumber: 42,
      settings: { promptTemplate: DEFAULT_FIX_REVIEW_ISSUES_PROMPT_TEMPLATE },
    });

    expect(prompt).toContain("Update pull request #42 with the completed fixes.");
    expect(prompt).toContain("Do not create a new pull request.");
  });
});
