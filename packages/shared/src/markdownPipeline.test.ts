import { expect, it } from "vite-plus/test";
import { unified } from "unified";
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
      '[Open thread](t3-thread://v1/environment/thread)\n\n<a href="javascript:alert(1)">Unsafe</a>',
    ),
  );
  expect(tree.children[0]).toMatchObject({
    tagName: "p",
    children: [
      {
        tagName: "a",
        properties: { href: "t3-thread://v1/environment/thread" },
        children: [{ type: "text", value: "Open thread" }],
      },
    ],
  });
  expect(JSON.stringify(tree)).not.toContain("javascript:");
});

it("keeps backslashes before punctuation in prose Windows drive paths", () => {
  const processor = unified()
    .use(remarkParse)
    .use(CHAT_MARKDOWN_REMARK_PLUGINS)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(CHAT_MARKDOWN_REHYPE_PLUGINS);
  const markdown = String.raw`Saved to C:\Users\me\.t3\_build\shot.png and C:/work\.config and C:\folder\(draft.`;

  expect(processor.runSync(processor.parse(markdown)).children).toMatchObject([
    { tagName: "p", children: [{ type: "text", value: markdown }] },
  ]);
});

it("keeps ordinary Markdown escapes and inline and fenced code unchanged around drive paths", () => {
  const processor = unified()
    .use(remarkParse)
    .use(CHAT_MARKDOWN_REMARK_PLUGINS)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(CHAT_MARKDOWN_REHYPE_PLUGINS);
  const code = String.raw`C:\Users\me\.t3\_build\shot.png \*literal\*`;
  const markdown = [
    String.raw`See C:\x and \*this\* and Note:\*that\*. Code: ` + "`" + code + "`",
    "",
    "```text",
    code,
    "```",
  ].join("\n");

  expect(processor.runSync(processor.parse(markdown)).children).toMatchObject([
    {
      tagName: "p",
      children: [
        { type: "text", value: String.raw`See C:\x and *this* and Note:*that*. Code: ` },
        { tagName: "code", children: [{ type: "text", value: code }] },
      ],
    },
    { type: "text", value: "\n" },
    {
      tagName: "pre",
      children: [{ tagName: "code", children: [{ type: "text", value: code + "\n" }] }],
    },
  ]);
});
