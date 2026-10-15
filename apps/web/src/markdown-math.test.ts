import { fromMarkdown } from "mdast-util-from-markdown";
import { describe, expect, it } from "vite-plus/test";

import { texMathFromMarkdown, texMathSyntax } from "./markdown-math";

type Node = { type: string; value?: string; children?: Node[] };

function parse(source: string): Node {
  return fromMarkdown(source, {
    extensions: [texMathSyntax],
    mdastExtensions: [texMathFromMarkdown],
  }) as Node;
}

function nodesIn(source: string, ...types: string[]): Node[] {
  const found: Node[] = [];
  const visit = (node: Node) => {
    if (types.includes(node.type)) found.push(node);
    node.children?.forEach(visit);
  };
  visit(parse(source));
  return found;
}

/** Math nodes in document order, as `type:value`. */
const mathIn = (source: string) =>
  nodesIn(source, "inlineMath", "math").map((node) => `${node.type}:${node.value}`);

/** Values of the code nodes in document order. */
const codeIn = (source: string) => nodesIn(source, "code").map((node) => node.value);

const typesOf = (node: Node) => node.children?.map((child) => child.type);

describe("TeX math syntax", () => {
  it("reads \\(…\\) inline, including TeX backslashes and underscores", () => {
    expect(mathIn("so \\(\\sigma\\propto r_1T^{-5}\\) holds")).toEqual([
      "inlineMath:\\sigma\\propto r_1T^{-5}",
    ]);
    // `\\` is a TeX line break, so the `)` after it does not close the formula.
    expect(mathIn("\\(a\\\\ b\\) c")).toEqual(["inlineMath:a\\\\ b"]);
    expect(mathIn("\\(a\\\\) c")).toEqual([]);
    expect(mathIn("| \\(G\\) | \\(x\\) |\n|---|---|\n| \\(a_1\\) | b |")).toEqual([
      "inlineMath:G",
      "inlineMath:x",
      "inlineMath:a_1",
    ]);
  });

  it("reads \\[ and \\] lines as display math, keeping lines that look like Markdown", () => {
    expect(mathIn("\\[\na=b\n\\quad\\Rightarrow\\quad c\n\\]")).toEqual([
      "math:a=b\n\\quad\\Rightarrow\\quad c",
    ]);
    expect(mathIn("text\n\n\\[\n- a\n# b\n\n> c\n\\]\n\nafter")).toEqual(["math:- a\n# b\n\n> c"]);
    expect(mathIn("> \\[\n> x\n> \\]")).toEqual(["math:x"]);
    expect(mathIn("- item\n\n  \\[\n  x^2\n  \\]")).toEqual(["math:x^2"]);
  });

  it("reads $$ lines as display math, keeping lines that look like Markdown or TeX", () => {
    expect(mathIn("$$\nx\n$$")).toEqual(["math:x"]);
    expect(mathIn("text\n\n$$\n- a\n\\[\n\n> c\n$$\n\nafter")).toEqual(["math:- a\n\\[\n\n> c"]);
    expect(mathIn("> $$\n> x\n> $$")).toEqual(["math:x"]);
    expect(mathIn("- item\n\n  $$\n  x^2\n  $$")).toEqual(["math:x^2"]);
  });

  it.each([
    ["an unclosed inline opener", "costs \\(x and more"],
    ["an empty formula", "\\(\\) text"],
    ["an escaped backslash", "\\\\(x\\\\)"],
    ["a code span", "`\\(x\\)` and \\(a `\\)` b"],
    ["a fenced block", "```\n\\[\nx\n\\]\n```"],
    ["an indented block", "    \\[\n    x\n    \\]"],
    ["a one-line display formula", "\\[ x \\]"],
    ["a one-line $$ formula", "$$ x $$"],
    ["inline $$ in text", "so $$x$$ holds"],
    ["currency", "Costs $5 and $10"],
    ["a single $", "$\nx\n$"],
    ["a citation", "see \\[1\\] and \\[2\\]"],
    ["a link target", "[a](https://x.test/\\(b\\))"],
  ])("leaves %s alone", (_, source) => {
    expect(mathIn(source)).toEqual([]);
  });

  it("closes an inline formula at its own closer when openers repeat", () => {
    expect(mathIn("\\(a \\(b\\) c")).toEqual(["inlineMath:b"]);
  });

  it("scans a message of unmatched openers in linear time", () => {
    const source = "\\( x ".repeat(20_000);
    const start = performance.now();
    expect(mathIn(source)).toEqual([]);
    expect(performance.now() - start).toBeLessThan(2000);
  });

  it("keeps an opener line inside a display block as formula content", () => {
    expect(mathIn("\\[\na\n\\[\nb\n\\]")).toEqual(["math:a\n\\[\nb"]);
  });

  it.each([
    ["an unclosed \\[ block", "\\[\nx = 1\n", "\\[\nx = 1"],
    ["an unclosed $$ block", "$$\nx = 1\n", "$$\nx = 1"],
    ["a $$ block closed by \\]", "$$\na\n\\]", "$$\na\n\\]"],
    ["a \\[ block closed by $$", "\\[\na\n$$", "\\[\na\n$$"],
    ["a display block cut by a lazy line", "> \\[\n> x\nlazy\n> \\]", "\\[\nx"],
    ["a display opener at the end", "text\n\n$$", "$$"],
  ])("shows %s as source in a code node", (_, source, code) => {
    expect(mathIn(source)).toEqual([]);
    expect(codeIn(source)).toEqual([code]);
  });

  it.each([
    ["\\[", "\\]"],
    ["$$", "$$"],
  ])("keeps the structure after a %s block", (open, close) => {
    const closed = parse(`Intro\n${open}\nx\n${close}\n\n- a\n- b\n\n> quote`);
    expect(typesOf(closed)).toEqual(["paragraph", "math", "list", "blockquote"]);
  });

  it.each(["\\[", "$$"])("runs an unclosed %s block to the end of the document", (open) => {
    const source = `Intro\n${open}\n\n- a\n- b\n\n> quote`;
    expect(typesOf(parse(source))).toEqual(["paragraph", "code"]);
    expect(codeIn(source)).toEqual([`${open}\n\n- a\n- b\n\n> quote`]);
    expect(codeIn(`Intro\n${open}\nx`)).toEqual([`${open}\nx`]);
  });

  it("ends an unclosed block with its list item", () => {
    const [list, quote] = parse("- item\n  $$\n  x\n- next\n\n> quote").children!;
    expect(typesOf(list!)).toEqual(["listItem", "listItem"]);
    expect(typesOf(list!.children![0]!)).toEqual(["paragraph", "code"]);
    expect(list!.children![0]!.children![1]!.value).toBe("$$\nx");
    expect(typesOf(list!.children![1]!)).toEqual(["paragraph"]);
    expect(quote?.type).toBe("blockquote");
  });

  it("ends an unclosed block with its blockquote", () => {
    const tree = parse("> $$\n> x\n\nafter");
    expect(typesOf(tree)).toEqual(["blockquote", "paragraph"]);
    expect(typesOf(tree.children![0]!)).toEqual(["code"]);
    expect(codeIn("> $$\n> x\n\nafter")).toEqual(["$$\nx"]);
  });

  it("scans a message of unmatched display openers in linear time", () => {
    const source = "\\[\nx\n".repeat(3200);
    const start = performance.now();
    expect(mathIn(source)).toEqual([]);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("does not rescan display openers inside an unclosed $$ block", () => {
    const source = `$$\n${"\\[\nx\n".repeat(3200)}`;
    const start = performance.now();
    expect(mathIn(source)).toEqual([]);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
