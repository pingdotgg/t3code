import { describe, expect, it } from "vite-plus/test";

import type { DiffThemeName } from "~/lib/diffRendering";

import { tokenizeBlock } from "./composerCodeBlockHighlight";

const THEME = "github-dark" as DiffThemeName;

/**
 * Stands in for the Shiki highlighter so the offset arithmetic can be checked
 * without loading a real grammar. Splits each line into whitespace-delimited
 * tokens, which is enough shape for the flattening logic under test.
 */
function fakeHighlighter(colorFor: (content: string) => string | undefined) {
  return {
    codeToTokens(code: string) {
      return {
        tokens: code.split("\n").map((line) =>
          line
            .split(/(\s+)/)
            .filter((part) => part.length > 0)
            .map((content) => ({ content, color: colorFor(content) })),
        ),
      };
    },
  } as unknown as Parameters<typeof tokenizeBlock>[0];
}

describe("composer code block highlighting", () => {
  it("maps token offsets to positions within the block text", () => {
    const highlighter = fakeHighlighter((content) => (content === "const" ? "#ff0000" : undefined));

    const decorations = tokenizeBlock(highlighter, "const answer = 42", "ts", THEME);

    expect(decorations).toEqual([{ from: 0, to: 5, color: "#ff0000" }]);
  });

  it("accounts for the newline between lines", () => {
    const highlighter = fakeHighlighter((content) => (content === "two" ? "#00ff00" : undefined));

    const decorations = tokenizeBlock(highlighter, "one\ntwo", "ts", THEME);

    // "one" is 3 characters, then the newline, so "two" starts at 4.
    expect(decorations).toEqual([{ from: 4, to: 7, color: "#00ff00" }]);
  });

  it("skips whitespace-only tokens so indentation is not decorated", () => {
    const highlighter = fakeHighlighter(() => "#0000ff");

    const decorations = tokenizeBlock(highlighter, "  indented", "ts", THEME);

    expect(decorations).toEqual([{ from: 2, to: 10, color: "#0000ff" }]);
  });

  it("falls back to plain text when the grammar throws", () => {
    const throwing = {
      codeToTokens() {
        throw new Error("unsupported language");
      },
    } as unknown as Parameters<typeof tokenizeBlock>[0];

    expect(tokenizeBlock(throwing, "const answer = 42", "nope", THEME)).toEqual([]);
  });
});
