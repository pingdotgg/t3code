import { describe, expect, it } from "vite-plus/test";

import { parseInlineMarkdown } from "./composer-rich-text";

describe("composer rich text markdown", () => {
  it("parses bold markers into styled spans", () => {
    expect(parseInlineMarkdown("hello **bold** world")).toEqual([
      { text: "hello ", marks: [] },
      { text: "bold", marks: ["bold"] },
      { text: " world", marks: [] },
    ]);
  });

  it("preserves unmatched markers, escaped markers, and identifiers", () => {
    for (const text of [
      "plain text",
      "snake_case",
      "unmatched **",
      "** spaced **",
      "\\*literal\\*",
    ]) {
      expect(parseInlineMarkdown(text)).toEqual([{ text, marks: [] }]);
    }
  });

  it("renders triple markers and nested styles", () => {
    expect(parseInlineMarkdown("***both***")).toEqual([
      { text: "both", marks: ["bold", "italic"] },
    ]);
    expect(parseInlineMarkdown("*a **b** c*")).toEqual([
      { text: "a ", marks: ["italic"] },
      { text: "b", marks: ["italic", "bold"] },
      { text: " c", marks: ["italic"] },
    ]);
    expect(parseInlineMarkdown("**a `code` c**")).toEqual([
      { text: "a ", marks: ["bold"] },
      { text: "code", marks: ["bold", "code"] },
      { text: " c", marks: ["bold"] },
    ]);
  });

  it("preserves crossing italic and bold spans", () => {
    expect(parseInlineMarkdown("*a**b*****c**")).toEqual([
      { text: "a", marks: ["italic"] },
      { text: "b", marks: ["italic", "bold"] },
      { text: "c", marks: ["bold"] },
    ]);
  });

  it("keeps repeated and alternate delimiters literal inside an active mark", () => {
    const repeated = "*".repeat(10_000);
    expect(parseInlineMarkdown(repeated + "text" + repeated)).toEqual([
      { text: repeated.slice(2) + "text", marks: ["bold"] },
      { text: repeated.slice(2), marks: [] },
    ]);
    const alternate = "__".repeat(5_000);
    expect(parseInlineMarkdown("**~~" + alternate + "text" + alternate + "~~**")).toEqual([
      { text: alternate + "text" + alternate, marks: ["bold", "strike"] },
    ]);
  });

  it("keeps code span contents literal", () => {
    expect(parseInlineMarkdown("`**not bold**`")).toEqual([
      { text: "**not bold**", marks: ["code"] },
    ]);
  });
});
