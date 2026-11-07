import { expect, it } from "vite-plus/test";
import { unified } from "unified";
import rehypeRaw from "rehype-raw";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import type { Root, RootContent } from "mdast";
import {
  CHAT_MARKDOWN_REHYPE_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS,
} from "./markdownPipeline.ts";

it.each([
  ["default", CHAT_MARKDOWN_REMARK_PLUGINS],
  ["with breaks", CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS],
] as const)("preserves trailing underscores and tildes in bare URLs (%s)", (_, plugins) => {
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
