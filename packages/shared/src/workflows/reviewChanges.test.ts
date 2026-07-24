import { describe, expect, it } from "vitest";
import {
  DEFAULT_REVIEW_CHANGES_PROMPT_TEMPLATE,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
} from "@t3tools/contracts";

import {
  buildReviewChangesPrompt,
  parseReviewChangesScope,
  reviewChangesVariantIdForScope,
} from "./reviewChanges.ts";

describe("buildReviewChangesPrompt", () => {
  it("builds the uncommitted review scope with untracked file instructions", () => {
    const prompt = buildReviewChangesPrompt({
      context: { scope: "uncommitted" },
      settings: { promptTemplate: "Custom reviewer instructions." },
    });

    expect(prompt).toContain("Review scope: uncommitted changes.");
    expect(prompt).toContain("git diff --cached");
    expect(prompt).toContain("git diff");
    expect(prompt).toContain("git ls-files --others --exclude-standard");
    expect(prompt).toContain("Do not review already committed branch changes");
    expect(prompt).toContain("Custom reviewer instructions.");
    expect(prompt).toContain("Return exactly one JSON object");
    expect(prompt).toContain('"code_location"');
    expect(prompt).not.toContain('"location":{"path":"relative/path"');
    expect(prompt).not.toContain("<review-snapshot>");
    expect(prompt.length).toBeLessThanOrEqual(PROVIDER_SEND_TURN_MAX_INPUT_CHARS);
  });

  it("builds the base branch review scope with merge-base instructions", () => {
    const prompt = buildReviewChangesPrompt({
      context: {
        scope: "against-base",
        baseBranch: "origin/main",
        mergeBaseSha: "abc123",
      },
      settings: { promptTemplate: "Custom reviewer instructions." },
    });

    expect(prompt).toContain("Review scope: changes against base branch.");
    expect(prompt).toContain("Base branch: origin/main");
    expect(prompt).toContain("Merge base: abc123");
    expect(prompt).toContain("git diff abc123");
    expect(prompt).toContain("git status --short");
    expect(prompt).toContain("Include committed branch changes");
  });

  it("builds a pull request review scope from its immutable snapshot", () => {
    const prompt = buildReviewChangesPrompt({
      context: {
        scope: "pull-request",
        number: 42,
        title: "Add pull request reviews",
        baseBranch: "main",
        headBranch: "feature/pr-reviews",
      },
      settings: { promptTemplate: "Custom reviewer instructions." },
    });

    expect(prompt).toContain("GitHub pull request #42");
    expect(prompt).toContain("Base branch: main");
    expect(prompt).toContain("Head branch: feature/pr-reviews");
    expect(prompt).toContain("Review only that patch");
  });

  it("falls back to the default instructions when the configured prompt is blank", () => {
    const prompt = buildReviewChangesPrompt({
      context: { scope: "uncommitted" },
      settings: { promptTemplate: "   " },
    });

    expect(prompt).toContain(DEFAULT_REVIEW_CHANGES_PROMPT_TEMPLATE);
  });
});

describe("reviewChangesVariantIdForScope", () => {
  it("uses the scope value as the variant id", () => {
    expect(reviewChangesVariantIdForScope("uncommitted")).toBe("uncommitted");
    expect(reviewChangesVariantIdForScope("against-base")).toBe("against-base");
    expect(reviewChangesVariantIdForScope("pull-request")).toBe("pull-request");
  });
});

describe("parseReviewChangesScope", () => {
  it("accepts every workflow review scope", () => {
    expect(parseReviewChangesScope("uncommitted")).toBe("uncommitted");
    expect(parseReviewChangesScope("against-base")).toBe("against-base");
    expect(parseReviewChangesScope("pull-request")).toBe("pull-request");
  });

  it("rejects invalid review scopes", () => {
    expect(parseReviewChangesScope("unknown")).toBeNull();
    expect(parseReviewChangesScope(43)).toBeNull();
  });
});
