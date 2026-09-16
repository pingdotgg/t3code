import { describe, expect, it } from "vite-plus/test";

import {
  docOffsetToMarkdownOffset,
  markdownOffsetToDocOffset,
  parseInlineMarkdown,
  richMarkRanges,
  serializeInlineMarkdown,
} from "./composer-rich-text";

describe("composer rich text markdown", () => {
  it("parses bold markers into styled spans", () => {
    expect(parseInlineMarkdown("hello **bold** world")).toEqual([
      { text: "hello ", marks: [] },
      { text: "bold", marks: ["bold"] },
      { text: " world", marks: [] },
    ]);
  });

  it("round-trips styled spans through markdown", () => {
    const cases = [
      "plain text",
      "hello **bold** world",
      "a *italic* word",
      "some `code` here",
      "struck ~~out~~ now",
      "**bold** and *italic* and `code`",
      "***bold italic***",
      "snake_case stays literal",
      "unmatched ** stays literal",
      "** spaced ** stays literal",
    ];
    for (const markdown of cases) {
      expect(serializeInlineMarkdown(parseInlineMarkdown(markdown))).toBe(markdown);
    }
  });

  it("keeps code span contents literal", () => {
    expect(parseInlineMarkdown("`**not bold**`")).toEqual([
      { text: "**not bold**", marks: ["code"] },
    ]);
  });

  it("maps document offsets past styled ranges to markdown offsets", () => {
    const spans = parseInlineMarkdown("hello **bold** world");
    const ranges = richMarkRanges(spans);
    // document text is "hello bold world"; the caret at the end of the
    // styled range sits before its closing markers.
    expect(docOffsetToMarkdownOffset(ranges, 6)).toBe(8);
    expect(docOffsetToMarkdownOffset(ranges, 10)).toBe(12);
    expect(docOffsetToMarkdownOffset(ranges, 16)).toBe(20);
  });

  it("clamps marker offsets to the styled edge", () => {
    const spans = parseInlineMarkdown("a **bold** c");
    const ranges = richMarkRanges(spans);
    const docLength = 8; // "a bold c"
    // markdown "a **bold** c": offsets 2..4 are the opening markers.
    expect(markdownOffsetToDocOffset(ranges, 2, docLength)).toBe(2);
    expect(markdownOffsetToDocOffset(ranges, 3, docLength)).toBe(2);
    // offsets 8..10 are the closing markers.
    expect(markdownOffsetToDocOffset(ranges, 9, docLength)).toBe(6);
    expect(markdownOffsetToDocOffset(ranges, 10, docLength)).toBe(6);
    // styled text maps back onto itself.
    expect(markdownOffsetToDocOffset(ranges, 6, docLength)).toBe(4);
    expect(markdownOffsetToDocOffset(ranges, 12, docLength)).toBe(8);
  });
});
