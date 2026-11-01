import { expect, it } from "vite-plus/test";
import { unified } from "unified";
import rehypeRaw from "rehype-raw";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { CHAT_MARKDOWN_REHYPE_PLUGINS, CHAT_MARKDOWN_REMARK_PLUGINS } from "./markdownPipeline.ts";

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
