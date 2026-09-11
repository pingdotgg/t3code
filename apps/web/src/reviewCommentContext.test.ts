import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import { describe, expect, it } from "vite-plus/test";

import { buildDiffReviewComment, restoreDiffReviewCommentRange } from "./reviewCommentContext";

describe("review comment context parsing", () => {
  it("formats mixed diff-side selections with the mobile review-comment contract", () => {
    const [fileDiff] = parsePatchFiles(
      [
        "diff --git a/src/app.ts b/src/app.ts",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -1,4 +1,4 @@",
        " one",
        "-two",
        "+TWO",
        " three",
        " four",
      ].join("\n"),
      "review-comment-test",
    )[0]!.files;

    const comment = buildDiffReviewComment({
      id: "comment-2",
      sectionId: "turn:2",
      sectionTitle: "Turn 2",
      filePath: "src/app.ts",
      fileDiff: fileDiff!,
      range: {
        start: 2,
        side: "deletions",
        end: 2,
        endSide: "additions",
      },
      text: "Keep this compatible.",
    });

    expect(comment).toEqual(
      expect.objectContaining({
        sectionId: "turn:2",
        sectionTitle: "Turn 2",
        filePath: "src/app.ts",
        startIndex: 1,
        endIndex: 2,
        rangeLabel: "2",
        text: "Keep this compatible.",
        diff: "@@ -2,1 +2,1 @@\n-two\n+TWO",
        fenceLanguage: "diff",
      }),
    );
  });

  it("restores Pierre line selections from persisted diff comment row indexes", () => {
    const fileDiff = parsePatchFiles(
      [
        "diff --git a/src/app.ts b/src/app.ts",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -1,3 +1,3 @@",
        " one",
        "-two",
        "+TWO",
        " three",
      ].join("\n"),
      "restore-review-comment-range",
    )[0]!.files[0]!;
    const comment = buildDiffReviewComment({
      id: "comment-6",
      sectionId: "turn:6",
      sectionTitle: "Turn 6",
      filePath: "src/app.ts",
      fileDiff,
      range: { start: 2, side: "deletions", end: 2, endSide: "additions" },
      text: "Keep both sides.",
    });

    expect(comment).not.toBeNull();
    expect(restoreDiffReviewCommentRange(fileDiff, comment!)).toEqual({
      start: 2,
      side: "deletions",
      end: 2,
      endSide: "additions",
    });
  });
});
