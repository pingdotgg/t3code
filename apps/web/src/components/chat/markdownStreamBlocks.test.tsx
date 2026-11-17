import {
  CHAT_MARKDOWN_REHYPE_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS,
  remarkAssistantInsights,
} from "@t3tools/shared/markdownPipeline";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import type { PluggableList } from "unified";
import { describe, expect, it } from "vite-plus/test";

import { splitMarkdownBlocks } from "./markdownStreamBlocks";
import { rehypeHeadingIds } from "./markdownFragments";

const MATH_PLUGINS: PluggableList = [[remarkMath, { singleDollarTextMath: true }]];

// Whitespace between top-level blocks collapses in the rendered message.
const renderMarkdown = (source: string, math = false) =>
  renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={[
        remarkAssistantInsights,
        ...(math ? MATH_PLUGINS : []),
        ...CHAT_MARKDOWN_REMARK_PLUGINS,
      ]}
      rehypePlugins={[...CHAT_MARKDOWN_REHYPE_PLUGINS, rehypeHeadingIds]}
    >
      {source}
    </ReactMarkdown>,
  )
    .replace(/>\s+</g, "><")
    .trim();

const html = (source: string) => renderMarkdown(source);

const punctuatedHeadings = ["Step 1: Install", "Done:", "apps/web", "Fix (web)", "What's next?"];

describe("splitMarkdownBlocks", () => {
  it.each([
    "# Title\n\nFirst paragraph with `code` and **bold**.\n\nSecond [link](https://example.com).",
    "## Step 1: Install\n\n## Step 1: Install\n\n[second](#step-1-install-1)",
    "## /home/a/b.ts\n\n## home/a/b.ts",
    "## see https://x.com/a\n\n## see httpsxcoma",
    "## Done:\n\n## Done",
    "## `Setup`\n\n## Setup",
    "## a ` x ` b\n\n## a x b",
    "# Setup\n\n# $$ Setup $$\n\n[second](#setup-1)",
    "# Setup\n\n# Setup\n\n[Second setup](#setup-1)",
    "\ufeff# Setup\n\n# Setup\n\n[second](#setup-1)",
    "> Setup\n> ===\n\n> Setup\n> ===",
    "# onetwo\n\none\ntwo\n===",
    "# Setup\n\n# &#83;etup\n\n[second](#setup-1)",
    "# Setup\n\npara\n\n- a\n\n  ```\n  b\nx\n\nSetup\n===\n",
    "Setup\n===\n\n> ## **Setup**\n\n- # [Setup](https://example.com)\n\n```sh\n# Setup\n```",
    "- one\n- two\n\n- loose three\n\n  continued\n\nAfter the list.",
    "1. first\n\n2. second\n\nText\n\n3) restarted",
    "```ts\nconst a = 1;\n\n\nconst b = 2;\n```\n\nafter\n\n~~~\nx\n\n~~~~\n\ny\n~~~\n\nend",
    "> quote\n\n> another quote\n\n> [!NOTE]\n> alert",
    "| a | b |\n| - | - |\n| 1 | 2 |\n\nAfter the table.",
    "para\n\n    indented code\n\nnext",
    "Setext\n===\n\nnext\n---\n\n- [ ] task\n- [x] done",
    "- a\n\n  ```\n  x\n\n```\n\nb",
    "- a\n\n  ```\n  x\n\ny\n\n  ```\n\nb",
    "```a``` is inline.\n\nprose\n\n```\none\n\ntwo\n```\n\nafter",
    "intro\n\n★ Insight ─────\nfirst\n\n```\n─────\n```\n\n- point\n─────\n\nafter\n\n`★ Insight ─────`\nsecond\n`─────`\n\nend",
  ])("renders each block as the whole text renders it, at every streamed prefix: %j", (text) => {
    for (let end = 0; end <= text.length; end++) {
      const source = text.slice(0, end);
      const blocks = splitMarkdownBlocks(source) ?? [source];
      expect(blocks.join("")).toBe(source);
      expect(blocks.map(html).join("")).toBe(html(source));
      expect(blocks.map((block) => renderMarkdown(block, true)).join("")).toBe(
        renderMarkdown(source, true),
      );
    }
  });

  it.each(punctuatedHeadings)("keeps splitting headings with prose punctuation: %s", (heading) => {
    expect(splitMarkdownBlocks(`## ${heading}\n\nNext paragraph.`)).toEqual([
      `## ${heading}\n\n`,
      "Next paragraph.",
    ]);
  });

  it("splits only between closed blocks", () => {
    expect(splitMarkdownBlocks("a\n\n```\nb\n\nc\n```\n\n- d\n\n- e\n\nf")).toEqual([
      "a\n\n",
      "```\nb\n\nc\n```\n\n- d\n\n- e\n\n",
      "f",
    ]);
    expect(splitMarkdownBlocks("a\n\n---\n\nb")).toEqual(["a\n\n", "---\n\n", "b"]);
  });

  it.each([
    "[ref]\n\n[ref]: /later",
    "a[^x]\n\n[^x]: note",
    "<details>\n\nbody\n\n</details>",
    ":::note\n\ncontent\n\n:::",
    "$$\na\n\nb\n$$",
    "a\r\n\r\nb",
  ])("keeps text with document-wide syntax whole: %j", (text) => {
    expect(splitMarkdownBlocks(text)).toBeNull();
  });
});
