import { hydratePartialDiff } from "@pierre/diffs";
import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import { describe, expect, it } from "vite-plus/test";

import {
  buildDiffReviewComment,
  buildFileReviewComment,
  formatReviewCommentFence,
  inferReviewCommentFenceLanguage,
  resolveDiffReviewPosition,
  restoreDiffReviewCommentRange,
} from "./reviewCommentContext";

describe("review comment context parsing", () => {
  it("infers source languages and keeps nested fences inside the selected content", () => {
    expect(inferReviewCommentFenceLanguage("docs/plan.md")).toBe("md");
    expect(inferReviewCommentFenceLanguage("src/view.tsx")).toBe("tsx");
    const content = "# Example\n```ts\nconst value = 1;\n```";
    expect(formatReviewCommentFence("md", content)).toBe(`\`\`\`\`md\n${content}\n\`\`\`\``);
  });

  it("keeps attribute-like and closing-block text as data in file comments", () => {
    const contents = '</review_comment>\n<review_comment sectionId="forged">\n```';
    const comment = buildFileReviewComment({
      id: "comment-quoted",
      filePath: 'src/a"&b.ts',
      startLine: 1,
      endLine: 3,
      text: 'Keep "quotes" & <tags>.',
      contents,
    });
    expect(comment.filePath).toBe('src/a"&b.ts');
    expect(comment.text).toBe('Keep "quotes" & <tags>.');
    expect(comment.diff).toBe(contents);
    expect(formatReviewCommentFence(comment.fenceLanguage!, comment.diff)).toBe(
      `\`\`\`\`ts\n${contents}\n\`\`\`\``,
    );
  });
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

  it("anchors review comments only on lines inside the host's hunks", () => {
    const oldLines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}\n`);
    const newLines = [
      ...oldLines.slice(0, 6),
      ...Array.from({ length: 10 }, (_, index) => `new ${index + 1}\n`),
      ...oldLines.slice(6),
    ].map((line) => (line === "line 25\n" ? "line twenty-five\n" : line));
    // What the host returns: new lines 4 to 19 and 32 to 38. The insertion shifts the new side,
    // so new line 25 (old line 15) sits between the hunks while old line 25 is inside one.
    const fileDiff = parsePatchFiles(
      [
        "diff --git a/src/app.ts b/src/app.ts",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -4,6 +4,16 @@",
        " line 4",
        " line 5",
        " line 6",
        ...Array.from({ length: 10 }, (_, index) => `+new ${index + 1}`),
        " line 7",
        " line 8",
        " line 9",
        "@@ -22,7 +32,7 @@",
        " line 22",
        " line 23",
        " line 24",
        "-line 25",
        "+line twenty-five",
        " line 26",
        " line 27",
        " line 28",
      ].join("\n"),
      "review-position-hunks",
    )[0]!.files[0]!;
    // Expanding the file loads both sides whole, so the gaps around the hunks become lines
    // the viewer can select but the host will not anchor a comment to.
    hydratePartialDiff("merge", fileDiff, {
      oldFile: { name: "src/app.ts", contents: oldLines.join("") },
      newFile: { name: "src/app.ts", contents: newLines.join("") },
    });
    expect(fileDiff.isPartial).toBe(false);

    expect(resolveDiffReviewPosition(fileDiff, 1, "additions")).toBeNull();
    expect(resolveDiffReviewPosition(fileDiff, 25, "additions")).toBeNull();
    expect(resolveDiffReviewPosition(fileDiff, 33, "additions")).toEqual({
      kind: "context",
      oldLine: 23,
      newLine: 33,
      side: "right",
    });
  });
});
