import { describe, expect, it } from "vite-plus/test";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { markdownMathRanges, remarkMath } from "./markdownMath.ts";

const parser = unified().use(remarkParse).use(remarkMath);

describe("Markdown math", () => {
  it.each([
    ["$x_i^2$", "x_i^2", false],
    ["$$x_i^2$$", "x_i^2", true],
    [String.raw`\(\frac{a}{b}\)`, String.raw`\frac{a}{b}`, false],
    [String.raw`\[\sum_i x_i\]`, String.raw`\sum_i x_i`, true],
    ["$$\nx_i + y\n$$", "x_i + y", true],
    [
      "\\[\n\\begin{aligned}\nx &= 1 \\\\\ny &= 2\n\\end{aligned}\n\\]",
      "\\begin{aligned}\nx &= 1 \\\\\ny &= 2\n\\end{aligned}",
      true,
    ],
  ])("recognizes %s", (source, tex, display) => {
    expect(markdownMathRanges(source)).toEqual([
      { source, math: { source, tex, display }, start: 0, end: source.length },
    ]);
  });

  it.each([
    "Costs $20 today and $30 tomorrow.",
    "$20.00, $30.00, and $40.00",
    "`$x$` and `\\(x\\)`",
    "```tex\n$$x$$\n```",
    "    \\[x\\]",
    String.raw`\$x\$ and \\(x\\)`,
    "[link](https://example.com/$x$)",
    "$$\nunfinished\n\nNext paragraph $5",
    "$ incomplete$ and $incomplete $",
    "$$$x$$$",
  ])("leaves literal content unchanged: %s", (source) => {
    expect(markdownMathRanges(source)).toEqual([]);
  });

  it("keeps exact source offsets alongside emoji, lists and emphasis", () => {
    const source = "🙂 **Fit** $x_i$\n\n- [ ] Verify \\(y\\)";
    const ranges = markdownMathRanges(source);
    expect(ranges.map((range) => source.slice(range.start, range.end))).toEqual([
      "$x_i$",
      "\\(y\\)",
    ]);
    expect(ranges.map((range) => range.math?.tex)).toEqual(["x_i", "y"]);
  });

  it("preserves incomplete backslash openers during streaming", () => {
    const paragraph = parser.parse(String.raw`Use \(x`).children[0];
    expect(
      paragraph?.type === "paragraph" &&
        paragraph.children.map((node) => ("value" in node ? node.value : "")).join(""),
    ).toBe(String.raw`Use \(x`);
  });

  it("does not interpret escaped dollar signs inside an expression as its end", () => {
    expect(markdownMathRanges(String.raw`$x + \$5$`)[0]?.math?.tex).toBe(String.raw`x + \$5`);
  });
});

it("ends unfinished backslash math at a paragraph boundary and preserves following Markdown", () => {
  const tree = parser.parse("\\(unfinished\n\n## Heading\n\n[link](https://example.com)");
  expect(tree.children[1]).toMatchObject({ type: "heading", depth: 2 });
  expect(tree.children[2]).toMatchObject({
    type: "paragraph",
    children: [{ type: "link", url: "https://example.com" }],
  });
});
