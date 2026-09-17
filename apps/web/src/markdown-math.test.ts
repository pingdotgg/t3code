import type { Root, RootContent } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified, type Plugin } from "unified";
import { describe, expect, it } from "vite-plus/test";

import { createIncrementalMarkdownPlugin } from "./markdown-incremental";
import { remarkNormalizeListItemIndentation } from "./markdown-list-indentation";
import { remarkChatMath } from "./markdown-math";

function parser() {
  return unified().use(remarkParse).use(remarkGfm).use(remarkChatMath);
}

function parse(source: string) {
  const processor = parser();
  return processor.runSync(processor.parse(source), source);
}

function mathNodes(tree: Root) {
  const result: Array<Extract<RootContent, { type: "math" | "inlineMath" }>> = [];
  const visit = (node: Root | RootContent) => {
    if (node.type === "math" || node.type === "inlineMath") result.push(node);
    if ("children" in node) node.children.forEach(visit);
  };
  visit(tree);
  return result;
}

describe("chat math", () => {
  it.each([
    [String.raw`$\frac{a_1}{b^2}$`, false],
    [String.raw`\(\frac{a_1}{b^2}\)`, false],
    [String.raw`$$\frac{a_1}{b^2}$$`, true],
    [String.raw`\[\frac{a_1}{b^2}\]`, true],
    ["$$\n\\frac{a_1}{b^2}\n$$", true],
    ["\\[\n\\frac{a_1}{b^2}\n\\]", true],
  ])("parses %s and preserves its copy source", (source, display) => {
    const nodes = mathNodes(parse(source));
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.value.trim()).toBe(String.raw`\frac{a_1}{b^2}`);
    expect(nodes[0]?.data?.hProperties).toEqual({
      className: [display ? "math-display" : "math-inline"],
      dataMathSource: source,
    });
  });

  it("keeps Markdown syntax inside formulas literal", () => {
    const source = String.raw`Text \(a_* + \text{**value**} + \text{\$5}\) then $x$2.`;
    expect(mathNodes(parse(source)).map((node) => node.value)).toEqual([
      String.raw`a_* + \text{**value**} + \text{\$5}`,
      "x",
    ]);
  });

  it("supports matrices, blank lines, and escaped backslashes in display math", () => {
    const equation = "\\begin{pmatrix}1 & 2 \\\\\n\n3 & 4\\end{pmatrix}";
    expect(mathNodes(parse(`\\[\n${equation}\n\\]`))[0]?.value.trim()).toBe(equation);
  });

  it("allows trailing whitespace after a display delimiter", () => {
    expect(mathNodes(parse("\\[\nx + y\n\nz\n\\]  \t"))[0]?.value).toBe("x + y\n\nz");
  });

  it.each(["> \\[\n> x+y\n> \\]", "- \\[\n  x+y\n  \\]"])(
    "copies multiline math without quote or list prefixes: %s",
    (source) => {
      expect(mathNodes(parse(source))[0]?.data?.hProperties?.dataMathSource).toBe("\\[\nx+y\n\\]");
    },
  );

  it.each([
    String.raw`Before \[x^2\] after.`,
    String.raw`- Inline \(x^2\) and $y$.`,
    "> \\[\n> x^2\n> \\]",
    "| Value |\n| --- |\n| \\(x^2\\) |",
    String.raw`[Equation \(x^2\)](https://example.com)`,
  ])("renders math inside prose and Markdown containers: %s", (source) => {
    expect(mathNodes(parse(source)).length).toBeGreaterThan(0);
  });

  it.each([
    String.raw`Use \`$x$ and \(y\)\` as examples.`.replaceAll("\\`", "`"),
    "```latex\n$x$ \\(y\\) \\[z\\]\n```",
    "~~~math\n$x$ \\(y\\)\n~~~",
    "    $x$ \\(y\\) \\[z\\]",
    String.raw`Escaped \$5 and \$10, and \\(x\\).`,
    String.raw`[Link](https://example.com/\(x\))`,
    String.raw`<div title="\(x\) and $x$">raw HTML</div>`,
    "The price rose from $5 to $10, then $20. Set $PATH later.",
  ])("preserves code, escapes, links, HTML, and prices: %s", (source) => {
    expect(mathNodes(parse(source))).toEqual([]);
  });

  it("preserves checkbox source positions after math", () => {
    const source = "\\[x\\]\n\n- [ ] task";
    const list = parse(source).children.find((node) => node.type === "list");
    expect(list?.children[0]?.position?.start.offset).toBe(source.indexOf("- [ ]"));
  });

  it("does not let prices consume a later equation", () => {
    expect(mathNodes(parse("$5 or $10 or $20, followed by $x+y$."))).toMatchObject([
      { value: "x+y" },
    ]);
  });

  it("keeps display math and its source when recovering an over-indented list", () => {
    const source = String.raw`-       \[x^2\]`;
    const processor = parser().use(remarkNormalizeListItemIndentation as Plugin<[], Root>);
    const tree = processor.runSync(processor.parse(source), source);
    expect(mathNodes(tree)[0]?.data?.hProperties).toEqual({
      className: ["math-display"],
      dataMathSource: String.raw`\[x^2\]`,
    });
  });

  it("can parse every streamed prefix and matches a fresh parse after cached code", () => {
    const incremental = createIncrementalMarkdownPlugin();
    const source =
      "```ts\nconst x = 1;\n```\n\n" +
      String.raw`Inline \(\frac{x}{2}\) and $y$.` +
      "\n\n\\[\n\\begin{aligned}a &= b \\\\\nc &= d\\end{aligned}\n\\]";
    for (let end = 0; end <= source.length; end++) {
      const prefix = source.slice(0, end);
      const processor = parser().use(incremental);
      expect(processor.runSync(processor.parse(prefix), prefix), `prefix ${end}`).toEqual(
        parse(prefix),
      );
    }
  });
});
