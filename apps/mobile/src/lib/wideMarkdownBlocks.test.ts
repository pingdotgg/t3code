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

  it("detects GFM tables", () => {
    expect(hasWideMarkdownBlock("| a | b |\n| --- | --- |\n| 1 | 2 |")).toBe(true);
    expect(hasWideMarkdownBlock("a | b\n:-- | --:\n1 | 2")).toBe(true);
  });
});
