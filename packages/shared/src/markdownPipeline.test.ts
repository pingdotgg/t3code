import { expect, it } from "vite-plus/test";
import { type PluggableList, unified } from "unified";
import rehypeRaw from "rehype-raw";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import type { Link, Root, RootContent } from "mdast";
import {
  CHAT_MARKDOWN_REHYPE_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS,
  remarkAssistantInsights,
  remarkEnableOrderedListNumbers,
} from "./markdownPipeline.ts";

it.each([
  ["default", CHAT_MARKDOWN_REMARK_PLUGINS],
  ["with breaks", CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS],
] as const)("preserves bare URL boundaries (%s)", (_, plugins) => {
  const processor = unified().use(remarkParse).use(plugins);
  const shape = (node: Root | RootContent): string => {
    if (node.type === "text") return node.value;
    if (node.type === "inlineCode") return `\`${node.value}\``;
    if (node.type === "code") return `\`\`\`${node.value}\`\`\``;
    const children = "children" in node ? node.children.map(shape).join("") : "";
    if (node.type === "link") return `[${children}](${node.url})`;
    if (node.type === "linkReference") return `[${children}][${node.identifier}]`;
    if (node.type === "emphasis") return `*${children}*`;
    if (node.type === "strong") return `**${children}**`;
    if (node.type === "delete") return `~~${children}~~`;
    return children;
  };
  const link = (url: string) => `[${url}](${/^www\./i.test(url) ? `http://${url}` : url})`;
  for (const url of [
    "https://x.com/dimasike_",
    "http://example.com/name__",
    "HTTPS://example.com/name_",
    "https://example.com/a_(b)_",
    "https://example.com/?name=value_",
    "https://example.com/#section_",
    "https://example.com/a_?name=value_#section_",
    "https://example.com/name~",
    "https://example.com/name~~",
    "https://example.com/name_~",
    "https://example.com/name~_",
    "https://example.com/name__~~_",
    "https://example.com/?name=value~",
    "https://example.com/#section~",
    "www.example.com/name_",
    "www.example.com/name~_",
    "WWW.example.com/name~~",
    "https://example.com/name-",
    "https://example.com/name/",
    "https://example.com/name%5F",
    "https://example.com/name%7E",
  ]) {
    for (const punctuation of ["", ".", ",", "!", "?", ":", ";", ")", "]", '"']) {
      const markdown = `See ${url}${punctuation} next`;
      expect(shape(processor.runSync(processor.parse(markdown), markdown) as Root), markdown).toBe(
        `See ${link(url)}${punctuation} next`,
      );
    }
  }
  for (const [markdown, expected] of [
    ["*https://x.com/dimasike_*", `*${link("https://x.com/dimasike_")}*`],
    ["**https://x.com/dimasike_**", `**${link("https://x.com/dimasike_")}**`],
    ["_https://x.com/dimasike_", `*${link("https://x.com/dimasike")}*`],
    ["__https://x.com/dimasike__", `**${link("https://x.com/dimasike")}**`],
    ["~~https://example.com/name_~~", `~~${link("https://example.com/name_")}~~`],
    ["~~https://example.com/name~~", `~~${link("https://example.com/name")}~~`],
    ["~https://example.com/name~", `~~${link("https://example.com/name")}~~`],
    ["*https://example.com/name~*", `*${link("https://example.com/name~")}*`],
    ["_https://example.com/name~_", `*${link("https://example.com/name~")}*`],
    ["[test](https://example.com/name~)", "[test](https://example.com/name~)"],
    ["[https://x.com/a](https://x.com/a)~_", `${link("https://x.com/a")}~_`],
    ["<https://x.com/a>~_", `${link("https://x.com/a")}~_`],
    ["[test][ref]~_\n\n[ref]: https://x.com/a~_", "[test][ref]~_"],
    ["`https://example.com/name~_`", "`https://example.com/name~_`"],
    ["```\nhttps://example.com/name~_\n```", "```https://example.com/name~_```"],
    ["https\\://example.com/name~_", link("https://example.com/name~_")],
    ["https://example.com/name. _~", `${link("https://example.com/name")}. _~`],
    ["Mail person@example.com_", "Mail person@example.com_"],
    ["Mail person@example.com ~_", "Mail [person@example.com](mailto:person@example.com) ~_"],
    ["[test](https://x.com/dimasike_)", "[test](https://x.com/dimasike_)"],
    ["[https://x.com/a](https://x.com/a)_", `${link("https://x.com/a")}_`],
    ["<https://x.com/a>_", `${link("https://x.com/a")}_`],
    ["[test][ref]_\n\n[ref]: https://x.com/a_", "[test][ref]_"],
    ["`https://x.com/dimasike_`", "`https://x.com/dimasike_`"],
    ["```\nhttps://x.com/dimasike_\n```", "```https://x.com/dimasike_```"],
    ["https://x.com/a. _", `${link("https://x.com/a")}. _`],
    ["https\\://x.com/dimasike_", link("https://x.com/dimasike_")],
    ["https://x.com/a\\_", link("https://x.com/a\\_")],
    ["https://x.com/a&#95;", `${link("https://x.com/a&#95")};`],
    [
      "可以看了：**http://localhost:18780**（已重启）。",
      `可以看了：**${link("http://localhost:18780")}**（已重启）。`,
    ],
    ["打开 http://localhost:18780，然后刷新", `打开 ${link("http://localhost:18780")}，然后刷新`],
    ["URL：https://example.com/a。下一句", `URL：${link("https://example.com/a")}。下一句`],
    ["（预览：http://localhost:18780）", `（预览：${link("http://localhost:18780")}）`],
    [
      "能打开 http://localhost:3000？见 http://localhost:3001；「www.example.com」",
      `能打开 ${link("http://localhost:3000")}？见 ${link("http://localhost:3001")}；「${link("www.example.com")}」`,
    ],
    [
      "__http://localhost:18780__，*http://localhost:3000*，~~http://localhost:3001~~。",
      `**${link("http://localhost:18780")}**，*${link("http://localhost:3000")}*，~~${link("http://localhost:3001")}~~。`,
    ],
    [
      "foo**http://localhost:18780**（bar）***http://localhost:3000***。",
      `foo**${link("http://localhost:18780")}**（bar）***${link("http://localhost:3000")}***。`,
    ],
    [
      "http://a.com。http://b.com，www.c.com、person@example.com。",
      `${link("http://a.com")}。${link("http://b.com")}，${link("www.c.com")}、[person@example.com](mailto:person@example.com)。`,
    ],
    [
      "**http://localhost:18780**（重启）。 https://example.com/a。结束",
      `**${link("http://localhost:18780")}**（重启）。 ${link("https://example.com/a")}。结束`,
    ],
    ["# **http://localhost:3000**，刷新", `**${link("http://localhost:3000")}**，刷新`],
    [
      "| a |\n| - |\n| **http://localhost:3000**，刷新 |",
      `a**${link("http://localhost:3000")}**，刷新`,
    ],
    ["www.example.com/preview。下一句", `${link("www.example.com/preview")}。下一句`],
    ["https://example.com/a_。下一句", `${link("https://example.com/a_")}。下一句`],
    ["https://example.com/a.，下一句", `${link("https://example.com/a")}.，下一句`],
    [
      "https://example.com/search?q=hello，world",
      `${link("https://example.com/search?q=hello")}，world`,
    ],
    ["https://example.com/日本語，続き", link("https://example.com/日本語，続き")],
    [
      "https://zh.wikipedia.org/wiki/北京（城市）",
      link("https://zh.wikipedia.org/wiki/北京（城市）"),
    ],
    ["https://example.com/a%EF%BC%8Cb", link("https://example.com/a%EF%BC%8Cb")],
    ["<https://example.com/日本語，続き>", link("https://example.com/日本語，続き")],
    ["[記事](https://example.com/a，b)", "[記事](https://example.com/a，b)"],
    ["[http://example.com/a，b](http://example.com/a，b)", link("http://example.com/a，b")],
    ["`https://example.com/a。次`", "`https://example.com/a。次`"],
    [
      "منشور على https://example.com/report، ونسخته",
      `منشور على ${link("https://example.com/report")}، ونسخته`,
    ],
    [
      "هل يعمل **http://localhost:3000**؟ نعم؛ www.example.com۔",
      `هل يعمل **${link("http://localhost:3000")}**؟ نعم؛ ${link("www.example.com")}۔`,
    ],
    [
      "https://x.com/a_ https://x.com/b_",
      `${link("https://x.com/a_")} ${link("https://x.com/b_")}`,
    ],
  ] as const) {
    expect(shape(processor.runSync(processor.parse(markdown), markdown) as Root), markdown).toBe(
      expected,
    );
  }
  for (const url of ["https://x.com/dimasike_", "www.example.com/name~_"]) {
    const markdown = `${url}, next`;
    const boundary = { line: 1, column: url.length + 1, offset: url.length };
    expect(processor.runSync(processor.parse(markdown), markdown)).toMatchObject({
      children: [
        {
          children: [
            {
              type: "link",
              url: /^www\./i.test(url) ? `http://${url}` : url,
              position: { end: boundary },
              children: [{ type: "text", value: url, position: { end: boundary } }],
            },
            { type: "text", value: ", next", position: { start: boundary } },
          ],
        },
      ],
    });
  }
});

it("ends bare URLs at CJK and Arabic punctuation with source positions", () => {
  const processor = unified().use(remarkParse).use(CHAT_MARKDOWN_REMARK_PLUGINS);
  const parse = (markdown: string) => processor.runSync(processor.parse(markdown), markdown);
  const at = (line: number, column: number, offset: number) => ({ line, column, offset });
  const url = "http://localhost:18780";
  expect(parse(`第一行\n可以看了：**${url}**（已重启）。`)).toMatchObject({
    children: [
      {
        children: [
          { type: "text", value: "第一行\n可以看了：", position: { end: at(2, 6, 9) } },
          {
            type: "strong",
            position: { start: at(2, 6, 9), end: at(2, 32, 35) },
            children: [
              {
                type: "link",
                url,
                position: { start: at(2, 8, 11), end: at(2, 30, 33) },
                children: [{ type: "text", value: url, position: { end: at(2, 30, 33) } }],
              },
            ],
          },
          {
            type: "text",
            value: "（已重启）。",
            position: { start: at(2, 32, 35), end: at(2, 38, 41) },
          },
        ],
      },
    ],
  });
  // Markup the URL swallowed comes back once the URL ends.
  expect(parse(`打开 ${url}，然后运行\`pnpm dev\``)).toMatchObject({
    children: [
      {
        children: [
          { type: "text", value: "打开 " },
          { type: "link", url },
          { type: "text", value: "，然后运行" },
          { type: "inlineCode", value: "pnpm dev" },
        ],
      },
    ],
  });
  // Every URL in one paragraph ends at its mark, with positions on its own line.
  const lines = Array.from({ length: 300 }, (_, index) => `接口：http://localhost:${index}，`);
  const [paragraph] = (parse(lines.join("\n")) as Root).children;
  const links =
    paragraph?.type === "paragraph"
      ? paragraph.children.filter((node): node is Link => node.type === "link")
      : [];
  expect(links.map((node) => node.url)).toEqual(
    lines.map((_, index) => `http://localhost:${index}`),
  );
  const lastLine = lines.slice(0, -1).join("\n").length + 1;
  expect(links.at(-1)).toMatchObject({
    position: { start: at(300, 4, lastLine + 3), end: at(300, 24, lastLine + 23) },
  });
  // Only a table unescapes `\|` in code, so that cell keeps its parse and the URL is cut.
  const descendants = (node: Root | RootContent): RootContent[] =>
    "children" in node
      ? (node.children as RootContent[]).flatMap((child) => [child, ...descendants(child)])
      : [];
  const cell = descendants(parse("| a |\n| - |\n| http://example.com， `a\\|b` |") as Root);
  expect(cell.flatMap((node) => (node.type === "link" ? [node.url] : []))).toEqual([
    "http://example.com",
  ]);
  expect(cell.flatMap((node) => (node.type === "inlineCode" ? [node.value] : []))).toEqual(["a|b"]);
  // A task item's checkbox is not part of its paragraph's text.
  const task = descendants(parse("- [x] http://example.com，刷新") as Root);
  expect(task.flatMap((node) => (node.type === "text" ? [node.value] : []))).toEqual([
    "http://example.com",
    "，刷新",
  ]);
  // A list item's indentation stays out of a code span that crosses lines.
  const code = descendants(parse("- `echo\n  hello` http://example.com，结束") as Root);
  expect(code.flatMap((node) => (node.type === "link" ? [node.url] : []))).toEqual([
    "http://example.com",
  ]);
  expect(code.flatMap((node) => (node.type === "inlineCode" ? [node.value] : []))).toEqual([
    "echo\nhello",
  ]);
  // A list item's continuation line parses the same on its own.
  expect(parse(`- 第一行\n  **${url}**（已重启）`)).toMatchObject({
    children: [
      {
        children: [
          {
            children: [
              {
                children: [
                  { type: "text", value: "第一行\n" },
                  { type: "strong", children: [{ type: "link", url }] },
                  { type: "text", value: "（已重启）" },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
  // A quote's continuation line does not, so the URL ends and the asterisks stay as text.
  expect(parse(`> 第一行\n> **${url}**（已重启）`)).toMatchObject({
    children: [
      {
        children: [
          {
            children: [
              { type: "text", value: "第一行\n**" },
              { type: "link", url, position: { end: at(2, 27, 32) } },
              { type: "text", value: "**（已重启）", position: { start: at(2, 27, 32) } },
            ],
          },
        ],
      },
    ],
  });
});

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

it("keeps local editor file links but not other schemes through the shared Markdown sanitizer", () => {
  const processor = unified()
    .use(remarkParse)
    .use(CHAT_MARKDOWN_REMARK_PLUGINS)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(CHAT_MARKDOWN_REHYPE_PLUGINS);
  const tree = processor.runSync(
    processor.parse(
      [
        "[cursor](cursor://file/Users/me/repo/file.md:3)",
        "[code](vscode://file/Users/me/repo/file.md:3:7)",
        "[insiders](vscode-insiders://file/Users/me/repo/file.md)",
        "[unknown](foo://file/Users/me/repo/file.md)",
        "[zed](zed://file/Users/me/repo/file.md)",
      ].join(" "),
    ),
  );
  type Node = { tagName?: string; properties?: { href?: string }; children?: Node[] };
  const hrefs = ((tree.children[0] as Node).children ?? [])
    .filter((node) => node.tagName === "a")
    .map((node) => node.properties?.href);
  expect(hrefs).toEqual([
    "cursor://file/Users/me/repo/file.md:3",
    "vscode://file/Users/me/repo/file.md:3:7",
    "vscode-insiders://file/Users/me/repo/file.md",
    undefined,
    undefined,
  ]);
});

it("keeps mixed-case local editor file links by lowercasing the scheme before sanitizing", () => {
  const processor = unified()
    .use(remarkParse)
    .use(CHAT_MARKDOWN_REMARK_PLUGINS)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(CHAT_MARKDOWN_REHYPE_PLUGINS);
  const tree = processor.runSync(
    processor.parse(
      [
        "[upper](VSCODE://file/Users/me/repo/file.md:3:7)",
        "[mixed](Cursor://file/Users/me/repo/file.md:3)",
        "[other](FOO://file/Users/me/repo/file.md)",
      ].join(" "),
    ),
  );
  type Node = { tagName?: string; properties?: { href?: string }; children?: Node[] };
  const hrefs = ((tree.children[0] as Node).children ?? [])
    .filter((node) => node.tagName === "a")
    .map((node) => node.properties?.href);
  expect(hrefs).toEqual([
    "vscode://file/Users/me/repo/file.md:3:7",
    "cursor://file/Users/me/repo/file.md:3",
    undefined,
  ]);
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

it("keeps the number written on each ordered list item only when enabled", () => {
  type Node = { tagName?: string; properties?: { value?: unknown }; children?: Node[] };
  const values = (node: Node): unknown[] => [
    ...(node.tagName === "li" ? [node.properties?.value] : []),
    ...(node.children ?? []).flatMap(values),
  ];
  const renderer = (plugins: PluggableList) => {
    const processor = unified()
      .use(remarkParse)
      .use(plugins)
      .use(remarkRehype, { allowDangerousHtml: true });
    return (markdown: string) =>
      values(processor.runSync(processor.parse(markdown), markdown) as Node);
  };
  const render = renderer([
    ...CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS,
    remarkEnableOrderedListNumbers,
  ]);

  expect(render("3. first\n5. second\n6. third")).toEqual([undefined, "5", undefined]);
  expect(render("1. one\n1. one again")).toEqual([undefined, "1"]);
  expect(render("> 1. quoted\n> 4. skipped")).toEqual([undefined, "4"]);
  expect(render("1. outer\n   1. nested\n   7. jump\n9. back")).toEqual([
    undefined,
    undefined,
    "7",
    "9",
  ]);
  expect(render("1. one\n2. two\n- bullet")).toEqual([undefined, undefined, undefined]);
  expect(render("-       first block\n\n        3. first\n        5. second")).toEqual([
    undefined,
    undefined,
    "5",
  ]);
  expect(
    renderer(CHAT_MARKDOWN_REMARK_PLUGINS)(
      "3. first\n5. second\n\n-       first block\n\n        3. first\n        5. second",
    ),
  ).toEqual([undefined, undefined, undefined, undefined, undefined]);
});

it("moves a <picture>'s color-scheme sources onto its <img>, which the renderer resolves", () => {
  const processor = unified()
    .use(remarkParse)
    .use(CHAT_MARKDOWN_REMARK_PLUGINS)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(CHAT_MARKDOWN_REHYPE_PLUGINS);
  type Node = { type: string; tagName?: string; properties?: object; children?: Node[] };
  const tags = (node: Node): string[] => [
    ...(node.tagName ? [node.tagName] : []),
    ...(node.children ?? []).flatMap(tags),
  ];
  const images = (node: Node): Node[] =>
    node.tagName === "img" ? [node] : (node.children ?? []).flatMap(images);
  const tree = processor.runSync(
    processor.parse(
      [
        "<picture>",
        '  <source media="(prefers-color-scheme: dark)" srcset="docs/dark.webp 1x, docs/dark@2x.webp 2x">',
        '  <source media="(prefers-color-scheme: dark)" srcset="docs/dark-unused.webp">',
        '  <source media="(min-width: 600px)" srcset="docs/wide.webp">',
        '  <img src="docs/light.webp" alt="Studio">',
        "</picture>",
        "",
        '<picture><source media="(prefers-color-scheme: light)" srcset="javascript:alert(1)"><img src="docs/dark.webp"></picture>',
        "",
        String.raw`<picture><source media="(prefers-color-scheme: dark)" srcset="C:\shots\dark.png"><img src="C:\shots\light.png"></picture>`,
      ].join("\n"),
    ),
  ) as Node;

  expect(tags(tree)).toEqual(["picture", "img", "p", "picture", "img", "p", "picture", "img"]);
  expect(images(tree).map((image) => image.properties)).toEqual([
    { src: "docs/light.webp", alt: "Studio", dataDarkSrc: "docs/dark.webp" },
    { src: "docs/dark.webp" },
    { dataLocalSrc: String.raw`C:\shots\light.png`, dataDarkSrc: "file:///C:/shots/dark.png" },
  ]);
});

it("links complete absolute paths in prose and skips shortened ones", () => {
  const path =
    "/tmp/claude-1000/-home-user--t3-worktrees-app-t3-abc123/session/scratchpad/notes.md";
  const processor = unified().use(remarkParse).use(CHAT_MARKDOWN_REMARK_PLUGINS);
  const links = (markdown: string) => {
    const urls: string[] = [];
    const visit = (node: Root | RootContent) => {
      if (node.type === "link") urls.push(node.url);
      if ("children" in node) node.children.forEach(visit);
    };
    visit(processor.runSync(processor.parse(markdown), markdown) as Root);
    return urls;
  };
  expect(links(`Saved to ${path} and /tmp/other.txt.`)).toEqual([path, "/tmp/other.txt"]);
  expect(links(`See (${path}:12).`)).toEqual([`${path}:12`]);
  expect(links("See /tmp/report(1).txt. and /tmp/app/[id]/page.tsx.")).toEqual([
    "/tmp/report(1).txt",
    "/tmp/app/[id]/page.tsx",
  ]);
  expect(links("(see /tmp/claude-1000/...). and /tmp/claude-1000/….")).toEqual([]);
  expect(links("Served at /index.html; GET /api/users.json; see /tmp/x.md:3.")).toEqual([
    "/tmp/x.md:3",
  ]);
  expect(
    links(
      '<a title="</a>" href="https://example.com">/tmp/notes.md</a> and **<a href="x">/tmp/a.md</a>**',
    ),
  ).toEqual([]);
  expect(
    links("Config lives in /Users/me/Library/Application Support/T3 Code/settings.json now."),
  ).toEqual([]);
  expect(links(`/chat/settings and https://example.com${path}`)).toEqual([
    `https://example.com${path}`,
  ]);
  expect(links(`[notes](${path}) and \`${path}\``)).toEqual([path]);
  expect(links(`\`\`\`\n${path}\n\`\`\``)).toEqual([]);
});
