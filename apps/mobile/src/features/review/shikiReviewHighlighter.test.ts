import { describe, expect, it } from "vitest";

import type { ReviewRenderableFile } from "./reviewModel";
import { highlightReviewFile } from "./shikiReviewHighlighter";

function makeRenderableFile(
  input: Partial<ReviewRenderableFile> & Pick<ReviewRenderableFile, "path">,
): ReviewRenderableFile {
  return {
    id: input.path,
    cacheKey: input.path,
    previousPath: null,
    changeType: "new",
    additions: 0,
    deletions: 0,
    languageHint: null,
    additionLines: [],
    deletionLines: [],
    rows: [],
    ...input,
  };
}

describe("highlightReviewFile", () => {
  it("preserves one highlighted token row per diff line even without trailing newlines", async () => {
    const file = makeRenderableFile({
      path: "apps/mobile/src/example.txt",
      additionLines: [
        'const items = ["a"];',
        'expect(items).toEqual(["a"]);',
        "const next = items.map((item) => item.toUpperCase());",
        'expect(next).toContain("A");',
      ],
    });

    const highlighted = await highlightReviewFile(file, "light");

    expect(highlighted.additionLines).toHaveLength(file.additionLines.length);
    expect(highlighted.additionLines[0]?.map((token) => token.content).join("")).toBe(
      file.additionLines[0],
    );
    expect(highlighted.additionLines[1]?.map((token) => token.content).join("")).toBe(
      file.additionLines[1],
    );
    expect(highlighted.additionLines[2]?.map((token) => token.content).join("")).toBe(
      file.additionLines[2],
    );
    expect(highlighted.additionLines[3]?.map((token) => token.content).join("")).toBe(
      file.additionLines[3],
    );
  });

  it("adds word-alt diff emphasis for paired deletion and addition lines", async () => {
    const file = makeRenderableFile({
      path: "apps/mobile/src/example-inline-diff.txt",
      additionLines: ["const after = 2;"],
      deletionLines: ["const before = 1;"],
      rows: [
        {
          kind: "line",
          id: "delete-1",
          change: "delete",
          oldLineNumber: 1,
          newLineNumber: null,
          content: "const before = 1;",
          additionTokenIndex: null,
          deletionTokenIndex: 0,
          comparison: { change: "add", tokenIndex: 0 },
        },
        {
          kind: "line",
          id: "add-1",
          change: "add",
          oldLineNumber: null,
          newLineNumber: 1,
          content: "const after = 2;",
          additionTokenIndex: 0,
          deletionTokenIndex: null,
          comparison: { change: "delete", tokenIndex: 0 },
        },
      ],
    });

    const highlighted = await highlightReviewFile(file, "light");

    expect(highlighted.deletionLines[0]?.some((token) => token.diffHighlight === true)).toBe(true);
    expect(highlighted.additionLines[0]?.some((token) => token.diffHighlight === true)).toBe(true);
  });

  it("falls back to plain tokens for very long lines", async () => {
    const longLine = `const value = "${"a".repeat(1_100)}";`;
    const file = makeRenderableFile({
      path: "apps/mobile/src/example-long-line.txt",
      additionLines: [longLine],
      rows: [
        {
          kind: "line",
          id: "add-1",
          change: "add",
          oldLineNumber: null,
          newLineNumber: 1,
          content: longLine,
          additionTokenIndex: 0,
          deletionTokenIndex: null,
          comparison: null,
        },
      ],
    });

    const highlighted = await highlightReviewFile(file, "light");

    expect(highlighted.additionLines).toHaveLength(1);
    expect(highlighted.additionLines[0]).toEqual([
      {
        content: longLine,
        color: null,
        fontStyle: null,
      },
    ]);
  });
});
