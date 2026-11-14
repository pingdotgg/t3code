import { describe, expect, it } from "vite-plus/test";

import { inlineMarkdownUnitMarks, parseInlineMarkdown } from "./composer-rich-text";

describe("composer rich text markdown", () => {
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

  // regression: #25180 underscores in URLs and paths were read as emphasis
  it("keeps underscores inside URLs, paths, and filenames literal", () => {
    for (const text of [
      "Read https://example.com/_handle_/status/1 and open src/__test__.tsx",
      "https://example.com/~_user_/a",
      "_build_/file.ts",
      "edit __init__.py, then",
      "see __init__.py:42",
      "open src/_a.ts_ and example.com/_handle_.",
      "/" + "_".repeat(50_000) + "a",
    ]) {
      expect(parseInlineMarkdown(text)).toEqual([{ text, marks: [] }]);
    }
    for (const [text, styled, mark, rest] of [
      ["_see src/a_b.ts_ now", "see src/a_b.ts", "italic", " now"],
      ["_read/write access_ now", "read/write access", "italic", " now"],
      ["__read/write access__ now", "read/write access", "bold", " now"],
      ["_see src/_a.ts_(optional)", "see src/_a.ts", "italic", "(optional)"],
      ["__see src/__a.ts__(optional)", "see src/__a.ts", "bold", "(optional)"],
      ["_see src/_a.ts_.", "see src/_a.ts", "italic", "."],
      ["_notes.md_ here", "notes.md", "italic", " here"],
      ["_e.g._ this", "e.g.", "italic", " this"],
      ["_and_/or", "and", "italic", "/or"],
    ] as const) {
      expect(parseInlineMarkdown(text)).toEqual([
        { text: styled, marks: [mark] },
        { text: rest, marks: [] },
      ]);
    }
    for (const [text, first, second, mark] of [
      ["_yes_/_no_", "yes", "no", "italic"],
      ["__yes__/__no__.", "yes", "no", "bold"],
      ["_a_b_/_no_", "a_b", "no", "italic"],
    ] as const) {
      expect(parseInlineMarkdown(text).slice(0, 3)).toEqual([
        { text: first, marks: [mark] },
        { text: "/", marks: [] },
        { text: second, marks: [mark] },
      ]);
    }
    expect(parseInlineMarkdown("and/_or_")).toEqual([
      { text: "and/", marks: [] },
      { text: "or", marks: ["italic"] },
    ]);
    expect(parseInlineMarkdown("_build_/file.ts and _x_, __init__.py and __y__")).toEqual([
      { text: "_build_/file.ts and ", marks: [] },
      { text: "x", marks: ["italic"] },
      { text: ", __init__.py and ", marks: [] },
      { text: "y", marks: ["bold"] },
    ]);
  });

  it("keeps code span contents literal", () => {
    expect(parseInlineMarkdown("`**not bold**`")).toEqual([
      { text: "**not bold**", marks: ["code"] },
    ]);
  });

  it("maps each source character to its marks, or null for a dropped delimiter", () => {
    const bold = ["bold"];
    expect(inlineMarkdownUnitMarks("**`*` w** \\*")).toEqual([
      null,
      null,
      null,
      ["bold", "code"],
      null,
      bold,
      bold,
      null,
      null,
      [],
      [],
      [],
    ]);
  });
});
