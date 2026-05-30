import { describe, expect, it } from "vitest";

import {
  countReviewCommentContexts,
  formatReviewCommentContext,
  parseReviewCommentMessageSegments,
  parseReviewInlineComments,
  type ReviewCommentTarget,
} from "./reviewCommentSelection";

function makeTarget(): ReviewCommentTarget {
  return {
    sectionId: "section-1",
    sectionTitle: "Working tree",
    filePath: "apps/demo/src/main.ts",
    startIndex: 0,
    endIndex: 1,
    lines: [
      {
        kind: "line",
        id: "line-1",
        change: "delete",
        oldLineNumber: 7,
        newLineNumber: null,
        content: "const retryLimit = 2;",
        additionTokenIndex: null,
        deletionTokenIndex: 0,
        comparison: null,
      },
      {
        kind: "line",
        id: "line-2",
        change: "add",
        oldLineNumber: null,
        newLineNumber: 7,
        content: "const retryLimit = 4;",
        additionTokenIndex: 0,
        deletionTokenIndex: null,
        comparison: null,
      },
    ],
  };
}

describe("review comment serialization", () => {
  it("preserves enough metadata for inline diff rendering", () => {
    const serialized = formatReviewCommentContext(makeTarget(), "Please keep this configurable.");

    expect(countReviewCommentContexts(serialized)).toBe(1);
    expect(parseReviewInlineComments(serialized)).toEqual([
      expect.objectContaining({
        sectionId: "section-1",
        sectionTitle: "Working tree",
        filePath: "apps/demo/src/main.ts",
        startIndex: 0,
        endIndex: 1,
        text: "Please keep this configurable.",
        diff: expect.stringContaining("-const retryLimit = 2;"),
      }),
    ]);
  });

  it("splits chat text into review comment segments", () => {
    const serialized = `Before\n${formatReviewCommentContext(makeTarget(), "Please keep this configurable.")}\nAfter`;
    const segments = parseReviewCommentMessageSegments(serialized);

    expect(segments).toHaveLength(3);
    expect(segments[0]).toEqual(expect.objectContaining({ kind: "text", text: "Before\n" }));
    expect(segments[1]).toEqual(
      expect.objectContaining({
        kind: "review-comment",
        comment: expect.objectContaining({
          filePath: "apps/demo/src/main.ts",
          text: "Please keep this configurable.",
          diff: expect.stringContaining("+const retryLimit = 4;"),
        }),
      }),
    );
    expect(segments[2]).toEqual(expect.objectContaining({ kind: "text", text: "\nAfter" }));
  });
});
