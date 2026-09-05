import { describe, expect, it, vi } from "vite-plus/test";

import type { ReviewRenderableLineRow } from "./reviewModel";
import {
  highlightCodeSnippet,
  highlightReviewSelectedLines,
  highlightSourceFile,
} from "./shikiReviewHighlighter";

function makeLine(
  input: Pick<ReviewRenderableLineRow, "id" | "content"> & Partial<ReviewRenderableLineRow>,
): ReviewRenderableLineRow {
  return {
    kind: "line",
    change: "add",
    oldLineNumber: null,
    newLineNumber: 1,
    additionTokenIndex: 0,
    deletionTokenIndex: null,
    comparison: null,
    ...input,
  };
}

describe("highlightReviewSelectedLines", () => {
  it("preserves one highlighted token row per selected diff line without trailing newlines", async () => {
    const contents = [
      'const items = ["a"];',
      'expect(items).toEqual(["a"]);',
      "const next = items.map((item) => item.toUpperCase());",
      'expect(next).toContain("A");',
    ];
    const lines = contents.map((content, index) => makeLine({ id: String(index), content }));
    const highlighted = await highlightReviewSelectedLines({
      filePath: "example.ts",
      lines,
      theme: "light",
    });

    expect(
      lines.map((line) => highlighted[line.id]?.map((token) => token.content).join("")),
    ).toEqual(contents);
  });

  it("adds word-alt diff emphasis for paired deletion and addition lines", async () => {
    const highlighted = await highlightReviewSelectedLines({
      filePath: "example.ts",
      theme: "light",
      lines: [
        makeLine({
          id: "delete-1",
          content: "const before = 1;",
          change: "delete",
          oldLineNumber: 1,
          newLineNumber: null,
          additionTokenIndex: null,
          deletionTokenIndex: 0,
          comparison: { change: "add", tokenIndex: 0 },
        }),
        makeLine({
          id: "add-1",
          content: "const after = 2;",
          comparison: { change: "delete", tokenIndex: 0 },
        }),
      ],
    });

    expect(highlighted["delete-1"]?.some((token) => token.diffHighlight === true)).toBe(true);
    expect(highlighted["add-1"]?.some((token) => token.diffHighlight === true)).toBe(true);
  });

  it("falls back to plain tokens for very long lines", async () => {
    const longLine = `const value = "${"a".repeat(1_100)}";`;
    const highlighted = await highlightReviewSelectedLines({
      filePath: "example.ts",
      theme: "light",
      lines: [makeLine({ id: "add-1", content: longLine })],
    });

    expect(highlighted["add-1"]).toEqual([
      {
        content: longLine,
        color: null,
        fontStyle: null,
      },
    ]);
  });
});

describe("highlightSourceFile", () => {
  it("preserves one highlighted token row per source line without trailing newlines", async () => {
    const lines = [
      'const items = ["a"];',
      'expect(items).toEqual(["a"]);',
      "const next = items.map((item) => item.toUpperCase());",
      'expect(next).toContain("A");',
    ];

    const highlighted = await highlightSourceFile({
      path: "apps/mobile/src/example.ts",
      contents: lines.join("\n"),
      theme: "light",
    });

    expect(highlighted.map((tokens) => tokens.map((token) => token.content).join(""))).toEqual(
      lines,
    );
  });

  it("falls back to plain tokens for very long lines", async () => {
    const longLine = `const value = "${"a".repeat(1_100)}";`;

    const highlighted = await highlightSourceFile({
      path: "apps/mobile/src/example-long-line.ts",
      contents: longLine,
      theme: "light",
    });

    expect(highlighted).toEqual([
      [
        {
          content: longLine,
          color: null,
          fontStyle: null,
        },
      ],
    ]);
  });

  it("initializes source and snippet highlighting without a warmup", async () => {
    vi.resetModules();
    const highlighter = await import("./shikiReviewHighlighter");
    const source = "const answer: number = 42;";

    const highlighted = await highlighter.highlightSourceFile({
      path: "example.ts",
      contents: source,
      theme: "dark",
    });

    expect(
      highlighted
        .flat()
        .map((token) => token.content)
        .join(""),
    ).toBe(source);
    expect(highlighted.flat().some((token) => token.color !== null)).toBe(true);
    expect(
      await highlighter.highlightCodeSnippet({ code: source, language: "ts", theme: "dark" }),
    ).toEqual(highlighted);
  });
});

describe("highlightReviewSelectedLines", () => {
  it("adds word-alt diff emphasis for paired deletion and addition lines", async () => {
    const lines: ReviewRenderableLineRow[] = [
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
    ];

    const highlighted = await highlightReviewSelectedLines({
      filePath: "apps/mobile/src/example-inline-diff.txt",
      lines,
      theme: "light",
    });

    expect(highlighted["delete-1"]?.some((token) => token.diffHighlight === true)).toBe(true);
    expect(highlighted["add-1"]?.some((token) => token.diffHighlight === true)).toBe(true);
  });
});

describe("highlightCodeSnippet", () => {
  it.each(["light", "dark"] as const)(
    "preserves diff-prefixed TSX review snippets in %s mode",
    async (theme) => {
      const lines = [
        "- onClick={() => submitOrder(cart)}",
        "+ onClick={handleSubmit}",
        "+ disabled={isSubmitting}",
      ];
      const highlighted = await highlightCodeSnippet({
        code: lines.join("\n"),
        language: "tsx",
        theme,
      });
      expect(highlighted.map((line) => line.map((token) => token.content).join(""))).toEqual(lines);
      expect(
        new Set(
          highlighted
            .flat()
            .map((token) => token.color)
            .filter(Boolean),
        ).size,
      ).toBeGreaterThan(1);
    },
  );

  it("resolves language aliases and returns syntax-colored tokens", async () => {
    const source = "const answer: number = 42;";
    const highlighted = await highlightCodeSnippet({
      code: source,
      language: "ts",
      theme: "dark",
    });

    expect(
      highlighted
        .flat()
        .map((token) => token.content)
        .join(""),
    ).toBe(source);
    expect(highlighted.flat().some((token) => token.color !== null)).toBe(true);
  });
});
