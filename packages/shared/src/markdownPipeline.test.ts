import { expect, it } from "vite-plus/test";
import { unified } from "unified";
import rehypeRaw from "rehype-raw";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import {
  CHAT_MARKDOWN_REHYPE_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS,
  remarkAssistantInsights,
} from "./markdownPipeline.ts";

const insightRule = "─".repeat(20);
const insightFence = (body: string, wrap = "") =>
  [`${wrap}★ Insight ${insightRule}${wrap}`, body, `${wrap}${insightRule}${wrap}`].join("\n");

it.each(["", "`"])("groups %j insight fences while preserving surrounding markdown", (wrap) => {
  const markdown = [
    "Before **bold** and [reference][src].",
    "",
    insightFence("- Also [reference][src].", wrap),
    "",
    "After.",
    "",
    '[src]:\n  https://example.com\n  "Source"',
  ].join("\n");
  const processor = unified()
    .use(remarkParse)
    .use(CHAT_MARKDOWN_REMARK_PLUGINS)
    .use(remarkAssistantInsights)
    .use(remarkRehype)
    .use(CHAT_MARKDOWN_REHYPE_PLUGINS);
  const tree = processor.runSync(processor.parse(markdown), markdown);
  expect(
    tree.children.filter((node) => node.type === "element").map((node) => node.tagName),
  ).toEqual(["p", "blockquote", "p"]);
  expect(
    tree.children.find((node) => node.type === "element" && node.tagName === "blockquote"),
  ).toMatchObject({ properties: { dataAlert: "insight" } });
  expect(JSON.stringify(tree).match(/"href":"https:\/\/example.com"/g)).toHaveLength(2);
  expect(JSON.stringify(tree)).toContain('"tagName":"strong"');
  expect(JSON.stringify(tree)).not.toContain(insightRule);
});

it.each([
  ["```text", "★ Insight " + insightRule, "literal", insightRule, "```"].join("\n"),
  ["- ```text", "  ★ Insight " + insightRule, "  literal", "  " + insightRule, "  ```"].join("\n"),
  ["    ★ Insight " + insightRule, "    literal", "    " + insightRule].join("\n"),
  ["Paragraph.", "    ★ Insight " + insightRule, "    literal", "    " + insightRule].join("\n"),
  ["`example", "★ Insight " + insightRule, "literal", insightRule, "`"].join("\n"),
  insightFence("quoted")
    .split("\n")
    .map((line) => "> " + line)
    .join("\n"),
])("leaves literal and nested insight examples unchanged: %s", (markdown) => {
  const processor = unified().use(remarkParse).use(remarkAssistantInsights);
  const tree = processor.parse(markdown);
  expect(processor.runSync(structuredClone(tree), markdown)).toEqual(tree);
});

it("groups streaming bodies and several insights without losing code or headings", () => {
  const markdown = [
    "## Setup",
    "",
    insightFence("```text\n" + insightRule + "\n```"),
    "",
    "## Setup",
    "",
    "★ Insight " + insightRule,
    "Still **streaming**",
  ].join("\n");
  const processor = unified().use(remarkParse).use(remarkAssistantInsights);
  const tree = processor.parse(markdown);
  processor.runSync(tree, markdown);
  expect(tree.children.map((node) => node.type)).toEqual([
    "heading",
    "blockquote",
    "heading",
    "blockquote",
  ]);
  expect(tree.children[1]).toMatchObject({ children: [{ type: "code", value: insightRule }] });
  expect(tree.children[3]).toMatchObject({
    children: [
      { type: "paragraph", children: [{ type: "text", value: "Still " }, { type: "strong" }] },
    ],
  });
});

it("keeps reference definitions out of unfinished streaming code", () => {
  const markdown = `[src]: https://example.com\n\n★ Insight ${insightRule}\n\`\`\`ts\nconst value = 1`;
  const processor = unified().use(remarkParse).use(remarkAssistantInsights);
  const tree = processor.parse(markdown);
  processor.runSync(tree, markdown);
  expect(tree.children.find((node) => node.type === "blockquote")).toMatchObject({
    children: [{ type: "code", value: "const value = 1" }],
  });
});

it("preserves footnotes and original code positions across a callout", () => {
  const code = "```sh\necho hello\n```";
  const markdown = ["Before[^n].", "", insightFence(code), "", "[^n]: Footnote."].join("\n");
  const processor = unified()
    .use(remarkParse)
    .use(remarkAssistantInsights)
    .use(CHAT_MARKDOWN_REMARK_PLUGINS);
  const tree = processor.parse(markdown);
  processor.runSync(tree, markdown);
  expect(tree.children[0]).toMatchObject({
    children: [
      { type: "text", value: "Before" },
      { type: "footnoteReference", identifier: "n" },
      { type: "text", value: "." },
    ],
  });
  expect(tree.children.at(-1)).toMatchObject({ type: "footnoteDefinition", identifier: "n" });
  const note = tree.children.find((node) => node.type === "blockquote");
  const block = note?.children[0];
  expect(markdown.slice(block?.position?.start.offset, block?.position?.end.offset)).toBe(code);
});

it("preserves in-app thread links through the shared Markdown sanitizer", () => {
  const processor = unified()
    .use(remarkParse)
    .use(CHAT_MARKDOWN_REMARK_PLUGINS)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(CHAT_MARKDOWN_REHYPE_PLUGINS);
  const tree = processor.runSync(
    processor.parse(
      '[Open thread](t3-thread://v1/thread)\n\n<t3-thread://v2/environment/thread:a%3A1>\n\n<a href="javascript:alert(1)">Unsafe</a>',
    ),
  );
  expect(tree.children[0]).toMatchObject({
    tagName: "p",
    children: [
      {
        tagName: "a",
        properties: { href: "t3-thread://v1/thread" },
        children: [{ type: "text", value: "Open thread" }],
      },
    ],
  });
  expect(tree.children[2]).toMatchObject({
    tagName: "p",
    children: [
      {
        tagName: "a",
        properties: { href: "t3-thread://v2/environment/thread:a%3A1" },
        children: [{ type: "text", value: "t3-thread://v2/environment/thread:a%3A1" }],
      },
    ],
  });
  expect(JSON.stringify(tree)).not.toContain("javascript:");
});

it("builds the tree rehype-raw builds for markdown without HTML", () => {
  type Node = {
    type: string;
    tagName?: string;
    value?: string;
    position?: unknown;
    data?: unknown;
    children?: Node[];
  };
  // What the round trip changes that renders the same; see `needsHtmlParser`.
  const comparable = (node: Node): Node => {
    const { position, children, data, ...rest } = node;
    const result: Node =
      node.type === "text" || node.type === "root" ? rest : { ...rest, position, data };
    if (!children) return result;
    const merged: Node[] = [];
    for (const child of children.map(comparable)) {
      const last = merged.at(-1);
      if (child.type === "text" && last?.type === "text") last.value += child.value ?? "";
      else merged.push(child);
    }
    // Blank text inside a table moves in front of it; the JSX runtime drops it in tables.
    const inTable = /^(?:table|thead|tbody|tfoot|tr)$/.test(node.tagName ?? "");
    result.children = merged.filter(
      (child, index) =>
        child.type !== "text" ||
        child.value?.trim() ||
        !(inTable || merged[index + 1]?.tagName === "table"),
    );
    return result;
  };
  const tree = (rehypePlugins: typeof CHAT_MARKDOWN_REHYPE_PLUGINS, markdown: string) => {
    const processor = unified()
      .use(remarkParse)
      .use(CHAT_MARKDOWN_REMARK_PLUGINS)
      .use(remarkRehype, { allowDangerousHtml: true })
      .use(rehypePlugins);
    return comparable(processor.runSync(processor.parse(markdown)) as Node);
  };
  const [first, , ...rest] = CHAT_MARKDOWN_REHYPE_PLUGINS;
  const withRaw = [first!, rehypeRaw, ...rest];
  for (const markdown of [
    "- [ ] open\n- [x] done\n\nNote[^1]\n\n[^1]: The note.",
    "| a | b |\n| :- | -: |\n| `c` | ![d](./d.png) |\n\n```ts title=x\nconst a = 1;\n```",
    // The HTML parser moves the footnote's link out of the label's link.
    "[note[^x]](https://example.com)\n\n[^x]: text",
    "**a** **b**\r\n> - | a |\r\n>   | - |\r\n>   | b |\r\n\n-\tx\n\n  y",
  ]) {
    expect(tree(CHAT_MARKDOWN_REHYPE_PLUGINS, markdown)).toEqual(tree(withRaw, markdown));
  }
});

it("keeps backslashes that CommonMark would read as escapes in prose Windows paths", () => {
  const processor = unified()
    .use(remarkParse)
    .use(CHAT_MARKDOWN_REMARK_PLUGINS)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(CHAT_MARKDOWN_REHYPE_PLUGINS);
  type Node = { type: string; value?: string; tagName?: string; children?: Node[] };
  const text = (node: Node): string =>
    node.type === "text"
      ? (node.value ?? "")
      : node.tagName === "code"
        ? `<code>${(node.children ?? []).map(text).join("")}</code>`
        : (node.children ?? []).map(text).join("");
  const render = (markdown: string) => text(processor.runSync(processor.parse(markdown)) as Node);

  expect(
    render(String.raw`Saved to C:\Users\me\.t3\_build and (C:\.scratch) and C:/work\.config.`),
  ).toBe(String.raw`Saved to C:\Users\me\.t3\_build and (C:\.scratch) and C:/work\.config.`);
  expect(render(String.raw`Escaped C:\\Users\\me`)).toBe(String.raw`Escaped C:\\Users\\me`);
  expect(render(String.raw`See C:\x and \*this\* and Note:\*that\*.`)).toBe(
    String.raw`See C:\x and *this* and Note:*that*.`,
  );
  expect(render(String.raw`${"`"}C:\me\.t3${"`"} and C:\me\.t3`)).toBe(
    String.raw`<code>C:\me\.t3</code> and C:\me\.t3`,
  );
});

it("keeps an image on its own line under a label but leaves inline images inline", () => {
  const processor = unified()
    .use(remarkParse)
    .use(CHAT_MARKDOWN_REMARK_PLUGINS)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(CHAT_MARKDOWN_REHYPE_PLUGINS);
  type Node = { type: string; value?: string; tagName?: string; children?: Node[] };
  const shape = (node: Node): string =>
    node.type === "text"
      ? (node.value ?? "")
      : node.tagName === "br" || node.tagName === "img"
        ? `<${node.tagName}>`
        : (node.children ?? []).map(shape).join("");
  const render = (markdown: string) => shape(processor.runSync(processor.parse(markdown)) as Node);

  expect(
    render("**Palette**\n![Palette](/tmp/palette.png)\n**Hero** (dark)\n![Hero](/tmp/hero.png)"),
  ).toBe("Palette<br>\n<img><br>\nHero (dark)<br>\n<img>");
  expect(render("Built [![CI](/ci.svg)](/ci)\nand wrapped")).toBe("Built <img>\nand wrapped");
  expect(render("Hard-wrapped\nprose")).toBe("Hard-wrapped\nprose");
});
