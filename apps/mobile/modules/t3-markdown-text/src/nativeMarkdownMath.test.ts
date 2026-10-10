import { describe, expect, it, vi } from "vite-plus/test";
import { parseMarkdownWithMath } from "@t3tools/shared/markdownMath";
import type { MarkdownNode } from "react-native-nitro-markdown/headless";

import { parseNativeMarkdownMath } from "./nativeMarkdownMath";

// Use CommonMark tokenization at the native code-span boundary: a regex would
// incorrectly accept adjacent backtick runs as separate spans.
function codeSpans(source: string): MarkdownNode {
  const tree = parseMarkdownWithMath(source);
  const children: MarkdownNode[] = [];
  const visit = (node: typeof tree | (typeof tree.children)[number]): void => {
    if (node.type === "inlineCode") {
      children.push({ type: "code_inline", content: node.value });
    } else if ("children" in node) {
      node.children.forEach(visit);
    }
  };
  visit(tree);
  return { type: "document", children };
}

describe("native math parsing", () => {
  it.each([
    [String.raw`\(\sqrt{x}\)`, "math_inline"],
    [String.raw`\[\sqrt{x}\]`, "math_block"],
    ["$$\\sqrt{x}$$", "math_inline"],
    ["$$\n\\sqrt{x}\n$$", "math_block"],
    ["```math\n\\sqrt{x}\n```", "math_block"],
    ["``` math\n\\sqrt{x}\n```", "math_block"],
    ["> \\[\n> \\sqrt{x}\n> \\]", "math_block"],
  ])("preserves TeX in %s", (source, type) => {
    expect(parseNativeMarkdownMath(source, codeSpans).children).toEqual([
      { type, content: String.raw`\sqrt{x}`, children: [] },
    ]);
  });

  it.each([
    [String.raw`\(x\)\(y\)`, ["math_inline", "math_inline"], ["x", "y"]],
    [String.raw`\[x\]\(y\)\[z\]`, ["math_block", "math_inline", "math_block"], ["x", "y", "z"]],
    ["`code`\\(x\\)`more`", ["code_inline", "math_inline", "code_inline"], ["code", "x", "more"]],
  ])("keeps adjacent formulas and code separate: %s", (source, types, contents) => {
    const nodes = parseNativeMarkdownMath(source, codeSpans).children ?? [];
    expect(nodes.map((node) => node.type)).toEqual(types);
    expect(nodes.map((node) => node.content ?? node.children?.[0]?.content)).toEqual(contents);
  });

  it.each(["`\\(x\\)", "``\\(x\\)", "\\(x\\)`", "``before \\(x\\) after ````"])(
    "restores math beside unmatched authored backticks: %s",
    (source) => {
      expect(parseNativeMarkdownMath(source, codeSpans).children).toEqual([
        { type: "math_inline", content: "x", children: [] },
      ]);
    },
  );

  it.each([
    "Pay $20 or $30.",
    String.raw`Unfinished \[\sqrt{x}`,
    String.raw`Unfinished \(x`,
    "`\\(x\\)` and ```\\[y\\]```",
    "```tex\n\\[x\\]\n```",
    String.raw`[documentation](https://example.com/\(x\))`,
    String.raw`<span title="\(x\)">example</span>`,
    "[\n\\sqrt{x}\n]",
  ])("leaves non-math source unchanged: %s", (source) => {
    const parse = vi.fn((): MarkdownNode => ({ type: "document" }));
    parseNativeMarkdownMath(source, parse);
    expect(parse).toHaveBeenCalledExactlyOnceWith(source);
  });

  it("keeps Markdown around equations and avoids collisions with authored code", () => {
    const source = "**Growth \\(x_1\\)** and `t3-math:0` then \\[y^2\\].";
    const parse = vi.fn(codeSpans);
    const result = parseNativeMarkdownMath(source, parse);
    expect(parse).toHaveBeenCalledWith(
      "**Growth ``t3-math::0``** and `t3-math:0` then ``t3-math::1``.",
    );
    expect(result.children?.map((node) => node.type)).toEqual([
      "math_inline",
      "code_inline",
      "math_block",
    ]);
  });
});
