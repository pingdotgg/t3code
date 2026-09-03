import { describe, expect, it } from "vite-plus/test";

import { hasWideMarkdownBlock } from "./wideMarkdownBlocks";

describe("hasWideMarkdownBlock", () => {
  it("ignores prose, inline code, and emphasis", () => {
    expect(hasWideMarkdownBlock("just a message")).toBe(false);
    expect(hasWideMarkdownBlock("I found it in `secteurs_intervention` earlier")).toBe(false);
    expect(hasWideMarkdownBlock("a | b in a sentence")).toBe(false);
    expect(hasWideMarkdownBlock("an em dash — and a rule\n\n---\n")).toBe(false);
  });

  it("detects fenced code blocks", () => {
    expect(hasWideMarkdownBlock("before\n```\ncode\n```\nafter")).toBe(true);
    expect(hasWideMarkdownBlock("before\n```ts\ncode\n```")).toBe(true);
    expect(hasWideMarkdownBlock("before\n~~~\ncode\n~~~")).toBe(true);
    expect(hasWideMarkdownBlock("   ```\ncode\n```")).toBe(true);
  });

  it("detects indented code blocks", () => {
    const prompt = 'before\n\n    def search(x):\n        return x\n\n"""\n\nafter';
    expect(hasWideMarkdownBlock(prompt)).toBe(true);
    expect(hasWideMarkdownBlock("before\n\n\treturn x\n\nafter")).toBe(true);
    expect(hasWideMarkdownBlock("before\n\n \treturn x\n\nafter")).toBe(true);
    expect(hasWideMarkdownBlock(">     return x")).toBe(true);
    expect(hasWideMarkdownBlock("> >  \treturn x")).toBe(true);
    expect(hasWideMarkdownBlock("    1. indented code")).toBe(true);
    expect(hasWideMarkdownBlock("    - code-like bullet")).toBe(true);
    expect(hasWideMarkdownBlock("before\n   not code\nafter")).toBe(false);
    expect(hasWideMarkdownBlock("before\n    \nafter")).toBe(false);
    expect(hasWideMarkdownBlock("before\n \t\nafter")).toBe(false);
  });

  it("detects top-level and blockquoted ordered-list markers", () => {
    expect(hasWideMarkdownBlock("1. One\n2. Two\n3. Three\n4. Four\n5. Five")).toBe(true);
    expect(hasWideMarkdownBlock("before\n3) Three")).toBe(true);
    expect(hasWideMarkdownBlock("> 1. One\n> 2. Two")).toBe(true);
    expect(hasWideMarkdownBlock("> > 3) Three")).toBe(true);
  });

  it("detects nested ordered lists", () => {
    expect(hasWideMarkdownBlock("- Parent\n    1. Child\n    2. Child")).toBe(true);
    expect(hasWideMarkdownBlock("> - Parent\n>     1. Child")).toBe(true);
  });

  it("can limit ordered-list width pinning to Android", () => {
    const orderedList = "1. One\n2. Two";
    expect(hasWideMarkdownBlock(orderedList, { includeOrderedLists: true })).toBe(true);
    expect(hasWideMarkdownBlock(orderedList, { includeOrderedLists: false })).toBe(false);
    expect(hasWideMarkdownBlock("```\ncode\n```", { includeOrderedLists: false })).toBe(true);
    expect(hasWideMarkdownBlock("| a | b |\n| --- | --- |", { includeOrderedLists: false })).toBe(
      true,
    );
  });

  it("detects blockquotes only when the native renderer needs width pinning", () => {
    expect(hasWideMarkdownBlock("> quoted", { includeBlockquotes: true })).toBe(true);
    expect(hasWideMarkdownBlock("  > quoted", { includeBlockquotes: true })).toBe(true);
    expect(hasWideMarkdownBlock("> quoted")).toBe(false);
    expect(hasWideMarkdownBlock("prose > quoted", { includeBlockquotes: true })).toBe(false);
    expect(hasWideMarkdownBlock("    > indented code", { includeBlockquotes: true })).toBe(true);
  });

  it("detects GFM tables", () => {
    expect(hasWideMarkdownBlock("| a | b |\n| --- | --- |\n| 1 | 2 |")).toBe(true);
    expect(hasWideMarkdownBlock("a | b\n:-- | --:\n1 | 2")).toBe(true);
  });
});
