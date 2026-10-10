import { describe, expect, it, vi } from "vite-plus/test";
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

type TreeNode = {
  type: string;
  tagName?: string;
  value?: string;
  position?: unknown;
  properties?: Record<string, unknown>;
  children?: TreeNode[];
};

/**
 * What the renderer shows: text positions and table whitespace are dropped, adjacent
 * text joins, and whitespace between blocks collapses.
 */
const text = (value: string): TreeNode => ({ type: "text", value: value.trim() ? value : "\n" });
function rendered(node: TreeNode, preserveWhitespace = false): TreeNode {
  if (node.type === "text") {
    return text(preserveWhitespace ? (node.value ?? "") : (node.value ?? "").replace(/\s+/g, " "));
  }
  if (!node.children) return node;
  const literal = preserveWhitespace || node.tagName === "pre";
  const table = ["table", "thead", "tbody", "tfoot", "tr"].includes(node.tagName ?? "");
  const children: TreeNode[] = [];
  for (const child of node.children.map((child) => rendered(child, literal))) {
    if (table && child.type === "text" && child.value?.trim() === "") continue;
    const last = children.at(-1);
    if (child.type === "text" && last?.type === "text") {
      const joined = `${last.value}${child.value}`;
      children[children.length - 1] = text(literal ? joined : joined.replace(/\s+/g, " "));
    } else children.push(child);
  }
  return {
    type: node.type,
    ...(node.tagName ? { tagName: node.tagName } : {}),
    ...(node.properties
      ? {
          properties: Object.fromEntries(
            Object.entries(node.properties)
              .filter(([, value]) => value !== false)
              .map(([key, value]) => [key, key.startsWith("data") && value === true ? "" : value]),
          ),
        }
      : {}),
    children,
  };
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

describe("raw HTML detection", () => {
  it("flags every way markdown can start raw HTML", () => {
    for (const markdown of ["<br>", "a</b>", "<!-- note -->", "<?php ?>", "<![CDATA[x]]>"]) {
      expect(markdownMayContainRawHtml(markdown)).toBe(true);
    }
  });

  it("renders tag-free markdown the same without rehype-raw", () => {
    const markdown = [
      "# Title & *emphasis*",
      "",
      "- [ ] task",
      "- [x] done with `code` and a [link](https://example.com 'Title')",
      "",
      "| a | b |",
      "| - | -: |",
      "| 1 < 2 | x |",
      "",
      "> [!NOTE]",
      "> An alert with ~~strike~~ and footnote[^1].",
      "",
      "```ts title=example.ts",
      "const a = 1 < 2;",
      "```",
      "",
      "![shot](C:\\Users\\me\\.t3\\shot.png)",
      "",
      "Entities &amp; &copy; and https://autolink.example",
      "",
      "[^1]: The footnote.",
    ].join("\n");
    expect(markdownMayContainRawHtml(markdown)).toBe(false);
    expect(rendered(chatMarkdownTree(markdown, false)).children).toEqual(
      rendered(chatMarkdownTree(markdown, true)).children,
    );
  });
});

describe("loadRehypeRaw", () => {
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
});
