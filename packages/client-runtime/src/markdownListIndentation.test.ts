import { describe, expect, it } from "vite-plus/test";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { remarkNormalizeListItemIndentation } from "./markdownListIndentation.ts";

interface TestNode {
  readonly type: string;
  readonly value?: string;
  readonly position?: {
    readonly start: { readonly line: number; readonly column: number; readonly offset: number };
    readonly end: { readonly line: number; readonly column: number; readonly offset: number };
  };
  readonly children?: readonly TestNode[];
}

const parser = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkNormalizeListItemIndentation)
  .freeze();

function parse(markdown: string): TestNode {
  return parser.runSync(parser.parse(markdown), { value: markdown }) as TestNode;
}

function nodesOfType(node: TestNode, type: string): TestNode[] {
  return [
    ...(node.type === type ? [node] : []),
    ...(node.children?.flatMap((child) => nodesOfType(child, type)) ?? []),
  ];
}

function sourceSlice(markdown: string, node: TestNode | undefined): string {
  expect(node?.position).toBeDefined();
  return markdown.slice(node?.position?.start.offset, node?.position?.end.offset);
}

describe("remarkNormalizeListItemIndentation source positions", () => {
  it("keeps inline Markdown ranges in the original source after removing the parser prefix", () => {
    const markdown = "Earlier text.\n\n-       lead **bold** [docs](https://example.com) `inline`";
    const tree = parse(markdown);

    expect(nodesOfType(tree, "code")).toEqual([]);
    expect(sourceSlice(markdown, nodesOfType(tree, "strong")[0])).toBe("**bold**");
    expect(sourceSlice(markdown, nodesOfType(tree, "link")[0])).toBe("[docs](https://example.com)");
    expect(sourceSlice(markdown, nodesOfType(tree, "inlineCode")[0])).toBe("`inline`");
    for (const node of nodesOfType(tree, "text")) {
      expect(sourceSlice(markdown, node)).toBe(node.value);
    }
  });

  it.each(["\n", "\r\n", "\r"])("maps multiline recovery with %j line endings", (newline) => {
    const markdown = [
      "-       **first**",
      "        [second](https://example.com)",
      "",
      "        **last**",
    ].join(newline);
    const tree = parse(markdown);
    const [first, last] = nodesOfType(tree, "strong");
    const [link] = nodesOfType(tree, "link");

    expect(sourceSlice(markdown, first)).toBe("**first**");
    expect(sourceSlice(markdown, link)).toBe("[second](https://example.com)");
    expect(sourceSlice(markdown, last)).toBe("**last**");
    expect(link?.position?.start).toEqual({
      line: 2,
      column: 9,
      offset: markdown.indexOf("[second]"),
    });
    expect(last?.position?.end).toEqual({ line: 4, column: 17, offset: markdown.length });
  });

  it("maps nested recovered lists repeatedly without returning synthetic coordinates", () => {
    const markdown = [
      "-       **outer**",
      "",
      "        -       **inner**",
      "",
      "                -       [deep](https://example.com)",
    ].join("\n");
    const tree = parse(markdown);

    expect(nodesOfType(tree, "code")).toEqual([]);
    expect(nodesOfType(tree, "list")).toHaveLength(3);
    expect(nodesOfType(tree, "strong").map((node) => sourceSlice(markdown, node))).toEqual([
      "**outer**",
      "**inner**",
    ]);
    const [link] = nodesOfType(tree, "link");
    expect(sourceSlice(markdown, link)).toBe("[deep](https://example.com)");
    expect(link?.position?.start).toEqual({
      line: 5,
      column: 25,
      offset: markdown.indexOf("[deep]"),
    });
    expect(link?.position?.end.offset).toBe(markdown.length);
  });

  it.each([
    ["blockquote prefixes", "> -       first\n>         **last**", 11],
    ["partially expanded tabs", "-\t\t first\n\t\t **last**", 4],
    ["preserved tabs", "-\t\t\t first\n\t\t\t **last**", 5],
  ])("maps %s using literal source characters", (_name, markdown, column) => {
    const tree = parse(markdown);
    const [last] = nodesOfType(tree, "strong");
    expect(nodesOfType(tree, "code")).toEqual([]);
    expect(sourceSlice(markdown, last)).toBe("**last**");
    expect(last?.position?.start).toEqual({
      line: 2,
      column,
      offset: markdown.indexOf("**last**"),
    });
    expect(last?.position?.end.offset).toBe(markdown.length);
  });

  it("keeps the final text boundary at the original streaming tail", () => {
    const tail = "\uE200cite\uE202turn0view0";
    const markdown = `-       first\n\n        -       last ${tail}`;
    const texts = nodesOfType(parse(markdown), "text");
    const last = texts.at(-1);
    expect(sourceSlice(markdown, last)).toBe(`last ${tail}`);
    expect(last?.position?.end.offset).toBe(markdown.length);
  });

  it("keeps GFM grammar and original ranges in recovered content", () => {
    const markdown = "-       ~~old~~ https://example.com";
    const tree = parse(markdown);
    expect(sourceSlice(markdown, nodesOfType(tree, "delete")[0])).toBe("~~old~~");
    expect(sourceSlice(markdown, nodesOfType(tree, "link")[0])).toBe("https://example.com");
  });

  it.each([
    "- ```ts\n  const value = 1;\n  ```",
    "-\n      const value = 1;",
    "-     const value = 1;",
    "-       prose\n\n            const value = 1;",
  ])("preserves genuine code in %j", (markdown) => {
    const code = nodesOfType(parse(markdown), "code");
    expect(code).toHaveLength(1);
    expect(code[0]?.value).toContain("const value = 1;");
  });
});
