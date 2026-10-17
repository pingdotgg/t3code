import { expect, it, vi } from "vite-plus/test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import rehypeRaw from "rehype-raw";
import {
  CHAT_MARKDOWN_REMARK_PLUGINS,
  chatMarkdownRehypePlugins,
  markdownMayContainRawHtml,
} from "./markdownPipeline.ts";

function chatMarkdownTree(markdown: string, rawHtml: boolean) {
  const processor = unified()
    .use(remarkParse)
    .use(CHAT_MARKDOWN_REMARK_PLUGINS)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(chatMarkdownRehypePlugins(rawHtml ? rehypeRaw : null));
  return processor.runSync(processor.parse(markdown));
}

it("preserves in-app thread links through the shared Markdown sanitizer", () => {
  const tree = chatMarkdownTree(
    '[Open thread](t3-thread://v1/environment/thread)\n\n<a href="javascript:alert(1)">Unsafe</a>',
    true,
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

it("flags every way markdown can start raw HTML", () => {
  for (const markdown of ["<br>", "a</b>", "<!-- note -->", "<?php ?>", "<![CDATA[x]]>"]) {
    expect(markdownMayContainRawHtml(markdown)).toBe(true);
  }
});

it("renders tag-free markdown without loading raw HTML", () => {
  const markdown = "# Title\n\n1 < 2 and **bold** with `code`";
  expect(markdownMayContainRawHtml(markdown)).toBe(false);
  expect(chatMarkdownTree(markdown, false).children).toEqual(
    chatMarkdownTree(markdown, true).children,
  );
});

it("keeps a failed load so every render waits on the same settled promise", async () => {
  vi.resetModules();
  vi.doMock("rehype-raw", () => {
    throw new Error("chunk failed");
  });
  try {
    const { loadRehypeRaw } = await import("./markdownPipeline.ts");
    const failed = loadRehypeRaw();
    await expect(failed).rejects.toThrow();
    expect(loadRehypeRaw()).toBe(failed);
  } finally {
    vi.doUnmock("rehype-raw");
  }
});
