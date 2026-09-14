import { describe, expect, it, vi } from "vite-plus/test";

import type { ReviewRenderableLineRow } from "./reviewModel";
import {
  highlightCodeSnippet,
  highlightReviewSelectedLines,
  highlightSourceFile,
  type ReviewHighlightedToken,
} from "./shikiReviewHighlighter";

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
    // Each entry point is held to the source text and to having highlighted it, rather than to
    // the other's tokens. Both ask for the same language and theme, so comparing the two only
    // pins how much of the grammar the engine had compiled by the time each one ran.
    const expectHighlighted = (
      tokenLines: ReadonlyArray<ReadonlyArray<ReviewHighlightedToken>>,
    ) => {
      expect(
        tokenLines
          .flat()
          .map((token) => token.content)
          .join(""),
      ).toBe(source);
      expect(tokenLines.flat().some((token) => token.color !== null)).toBe(true);
    };

    expectHighlighted(
      await highlighter.highlightSourceFile({
        path: "example.ts",
        contents: source,
        theme: "dark",
      }),
    );
    expectHighlighted(
      await highlighter.highlightCodeSnippet({ code: source, language: "ts", theme: "dark" }),
    );
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
