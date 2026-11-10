import {
  CHAT_MARKDOWN_REHYPE_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS,
} from "@t3tools/shared/markdownPipeline";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { describe, expect, it } from "vite-plus/test";

import { createMarkdownBlockSplitter, splitMarkdownBlocks } from "./markdownStreamBlocks";

// Whitespace between top-level blocks collapses in the rendered message.
const html = (source: string) =>
  renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={CHAT_MARKDOWN_REMARK_PLUGINS}
      rehypePlugins={CHAT_MARKDOWN_REHYPE_PLUGINS}
    >
      {source}
    </ReactMarkdown>,
  )
    .replace(/>\s+</g, "><")
    .trim();

describe("splitMarkdownBlocks", () => {
  it.each([
    "# Title\n\nFirst paragraph with `code` and **bold**.\n\nSecond [link](https://example.com).",
    "- one\n- two\n\n- loose three\n\n  continued\n\nAfter the list.",
    "1. first\n\n2. second\n\nText\n\n3) restarted",
    "```ts\nconst a = 1;\n\n\nconst b = 2;\n```\n\nafter\n\n~~~\nx\n\n~~~~\n\ny\n~~~\n\nend",
    "> quote\n\n> another quote\n\n> [!NOTE]\n> alert",
    "| a | b |\n| - | - |\n| 1 | 2 |\n\nAfter the table.",
    "para\n\n    indented code\n\nnext",
    "Setext\n===\n\nnext\n---\n\n- [ ] task\n- [x] done",
    "- a\n\n  ```\n  x\n\n```\n\nb",
    "- a\n\n  ```\n  x\n\ny\n\n  ```\n\nb",
    "# Title\n\nLead\n\n- item\n\n- another\n\n1. first\n\n2. second\n\nTail",
    "Before\n\n```md\n[ref]: /x\n\n<details>\n$$\n[^n]\n```\n\nAfter",
  ])("renders each block as the whole text renders it, at every streamed prefix: %j", (text) => {
    const splitStream = createMarkdownBlockSplitter();
    for (let end = 0; end <= text.length; end++) {
      const source = text.slice(0, end);
      const blocks = splitMarkdownBlocks(source);
      expect(blocks?.join("")).toBe(source);
      expect(blocks!.map(html).join("")).toBe(html(source));
      expect(splitStream(source)).toEqual(blocks);
    }
  });

  it("splits only between closed blocks", () => {
    expect(splitMarkdownBlocks("a\n\n```\nb\n\nc\n```\n\n- d\n\n- e\n\nf")).toEqual([
      "a\n\n",
      "```\nb\n\nc\n```\n\n- d\n\n- e\n\n",
      "f",
    ]);
  });

  it.each([
    "[ref]\n\n[ref]: /later",
    "```bad`info\n\n[ref]\n\n[ref]: /later",
    "a[^x]\n\n[^x]: note",
    "<details>\n\nbody\n\n</details>",
    ":::note\n\ncontent\n\n:::",
    "$$\na\n\nb\n$$",
    "a\r\n\r\nb",
    "first\n\nsecond\n\nthird\n\n[ref]\n\n[ref]: /later",
    "first\n\nsecond\n\nthird\n\ninternal\uFEFFmark",
  ])("keeps text with document-wide syntax whole: %j", (text) => {
    expect(splitMarkdownBlocks(text)).toBeNull();
    const splitStream = createMarkdownBlockSplitter();
    for (let end = 0; end <= text.length; end++) {
      const source = text.slice(0, end);
      expect(splitStream(source)).toEqual(splitMarkdownBlocks(source));
    }
  });

  it("resets when the reply is edited or replaced after closing blocks", () => {
    const splitStream = createMarkdownBlockSplitter();
    for (const text of [
      "a\n\nb\n\nc\n\nd",
      "a\n\nb\n\nc\n\n-",
      "a\n\nb\n\nc\n\n- item",
      "[x]: /x",
      "new\n\nreply",
    ]) {
      expect(splitStream(text)).toEqual(splitMarkdownBlocks(text));
    }
  });
});
