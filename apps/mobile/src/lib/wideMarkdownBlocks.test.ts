import { describe, expect, it } from "vite-plus/test";

import { hasWideMarkdownBlock } from "./wideMarkdownBlocks";

describe("hasWideMarkdownBlock", () => {
  it("ignores prose, inline code, and emphasis", () => {
    expect(hasWideMarkdownBlock("just a message")).toBe(false);
    expect(hasWideMarkdownBlock("I found it in `secteurs_intervention` earlier")).toBe(false);
    expect(hasWideMarkdownBlock("a | b in a sentence")).toBe(false);
    expect(hasWideMarkdownBlock("an em dash — and a rule\n\n---\n")).toBe(false);
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
});
