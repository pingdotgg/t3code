import { describe, expect, it } from "vite-plus/test";

import {
  appendReviewCommentsToPrompt,
  buildFileReviewComment,
  buildReviewCommentRenderablePatch,
  parseReviewCommentMessageSegments,
} from "./reviewCommentContext";

describe("review comment context parsing", () => {
  it("extracts comment metadata, user text, and fenced diff without raw wrapper text", () => {
    const segments = parseReviewCommentMessageSegments(
      [
        'Before <review_comment sectionId="turn:2" sectionTitle="Turn 2" filePath="apps/web/src/lib/contextWindow.test.ts" startIndex="3" endIndex="14" rangeLabel="+47 to +58">',
        "Wadduo",
        "```diff",
        "@@ -0,0 +47,2 @@",
        '+  it("keeps valid zero-usage snapshots", () => {',
        "+    expect(snapshot).not.toBeNull();",
        "```",
        "</review_comment> after",
      ].join("\n"),
    );

    expect(segments).toHaveLength(3);
    expect(segments[0]).toEqual(
      expect.objectContaining({
        kind: "text",
        text: expect.stringContaining("Before"),
      }),
    );
    expect(segments[1]).toEqual(
      expect.objectContaining({
        kind: "review-comment",
        comment: expect.objectContaining({
          filePath: "apps/web/src/lib/contextWindow.test.ts",
          rangeLabel: "+47 to +58",
          text: "Wadduo",
          diff: expect.stringContaining('it("keeps valid zero-usage snapshots"'),
        }),
      }),
    );
    expect(segments[2]).toEqual(
      expect.objectContaining({
        kind: "text",
        text: " after",
      }),
    );
  });

  it("wraps hunk-only review diffs in a renderable file patch", () => {
    const [segment] = parseReviewCommentMessageSegments(
      [
        '<review_comment sectionId="s" filePath="src/app.ts" startIndex="0" endIndex="0">',
        "Please check this.",
        "```diff",
        "@@ -1,1 +1,1 @@",
        "-old",
        "+new",
        "```",
        "</review_comment>",
      ].join("\n"),
    );

    expect(segment?.kind).toBe("review-comment");
    if (segment?.kind !== "review-comment") return;

    expect(buildReviewCommentRenderablePatch(segment.comment)).toBe(
      [
        "diff --git a/src/app.ts b/src/app.ts",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -1,1 +1,1 @@",
        "-old",
        "+new",
      ].join("\n"),
    );
  });

  it("formats editable file comments with the mobile review-comment contract", () => {
    const comment = buildFileReviewComment({
      id: "comment-1",
      filePath: "src/app.ts",
      startLine: 2,
      endLine: 3,
      text: "Keep this configurable.",
      contents: ["one", "two", "three", "four"].join("\n"),
    });
    const prompt = appendReviewCommentsToPrompt("Please update this.", [comment]);
    const segments = parseReviewCommentMessageSegments(prompt);

    expect(segments).toHaveLength(2);
    expect(segments[1]).toEqual(
      expect.objectContaining({
        kind: "review-comment",
        comment: expect.objectContaining({
          filePath: "src/app.ts",
          startIndex: 1,
          endIndex: 2,
          rangeLabel: "L2 to L3",
          text: "Keep this configurable.",
          diff: "@@ -2,2 +2,2 @@\n two\n three",
        }),
      }),
    );
  });
});
