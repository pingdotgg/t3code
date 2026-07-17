import { describe, expect, it } from "vitest";
import { DEFAULT_REVIEW_CHANGES_PROMPT_TEMPLATE } from "@t3tools/contracts";

import { buildReviewChangesPrompt, reviewChangesVariantIdForScope } from "./reviewChanges.ts";

describe("buildReviewChangesPrompt", () => {
  it("builds the uncommitted review scope with untracked file instructions", () => {
    const prompt = buildReviewChangesPrompt({
      context: { scope: "uncommitted" },
      settings: { promptTemplate: "Custom reviewer instructions." },
      snapshot: {
        scope: { kind: "uncommitted", branch: "main", untrackedFiles: [] },
        diff: "diff --git a/a.ts b/a.ts\n",
        diffHash: "snapshot-hash",
        truncated: false,
      },
    });

    expect(prompt).toContain("Review scope: uncommitted changes.");
    expect(prompt).toContain("git diff --cached");
    expect(prompt).toContain("git diff");
    expect(prompt).toContain("git ls-files --others --exclude-standard");
    expect(prompt).toContain("Do not review already committed branch changes");
    expect(prompt).toContain("Custom reviewer instructions.");
    expect(prompt).toContain('"diffHash":"snapshot-hash"');
    expect(prompt).toContain("Return exactly one JSON object");
  });

  it("builds the base branch review scope with merge-base instructions", () => {
    const prompt = buildReviewChangesPrompt({
      context: {
        scope: "against-base",
        baseBranch: "origin/main",
        mergeBaseSha: "abc123",
      },
      settings: { promptTemplate: "Custom reviewer instructions." },
      snapshot: {
        scope: {
          kind: "against-base",
          branch: "feature",
          baseBranch: "origin/main",
          mergeBaseSha: "abc123",
          untrackedFiles: [],
        },
        diff: "diff --git a/a.ts b/a.ts\n",
        diffHash: "snapshot-hash",
        truncated: false,
      },
    });

    expect(prompt).toContain("Review scope: changes against base branch.");
    expect(prompt).toContain("Base branch: origin/main");
    expect(prompt).toContain("Merge base: abc123");
    expect(prompt).toContain("git diff abc123");
    expect(prompt).toContain("git status --short");
    expect(prompt).toContain("Include committed branch changes");
  });

  it("falls back to the default instructions when the configured prompt is blank", () => {
    const prompt = buildReviewChangesPrompt({
      context: { scope: "uncommitted" },
      settings: { promptTemplate: "   " },
      snapshot: {
        scope: { kind: "uncommitted", branch: null, untrackedFiles: [] },
        diff: "",
        diffHash: "snapshot-hash",
        truncated: false,
      },
    });

    expect(prompt).toContain(DEFAULT_REVIEW_CHANGES_PROMPT_TEMPLATE);
  });
});

describe("reviewChangesVariantIdForScope", () => {
  it("uses the scope value as the variant id", () => {
    expect(reviewChangesVariantIdForScope("uncommitted")).toBe("uncommitted");
    expect(reviewChangesVariantIdForScope("against-base")).toBe("against-base");
  });
});
