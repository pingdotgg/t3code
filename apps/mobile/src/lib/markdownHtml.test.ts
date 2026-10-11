import { describe, expect, it } from "vite-plus/test";
import type { MarkdownNode } from "react-native-nitro-markdown/headless";
import {
  markdownHtmlContent,
  nativeMarkdownWithHtml,
  nativeMarkdownDocumentChunks,
} from "@t3tools/mobile-markdown-text/markdown";

describe("HTML in native Markdown", () => {
  it("leaves code inside an HTML details block literal", () => {
    const content =
      '<details>\n<summary>Example</summary>\n\n```html\n<img src="literal.png">\n```\n\nUse `<img>` here.\n</details>';
    const result = markdownHtmlContent(content);
    expect(result).toContain('```html\n<img src="literal.png">\n```');
    expect(result).toContain("Use `<img>` here.");
    expect(result).not.toContain("<details>");
  });
  it("preserves screenshot URLs and captions from GitHub HTML image embeds", () => {
    expect(
      markdownHtmlContent(
        '<img width="900" alt="Before > after [settings]" src="https://example.com/before.png?a=1&amp;b=2" />',
      ),
    ).toBe("![Before > after \\[settings\\]](<https://example.com/before.png?a=1&b=2>)");
    expect(
      markdownHtmlContent(
        "<a href='https://example.com'><img src='https://example.com/banner.svg' alt='Review' /></a>",
      ),
    ).toBe("![Review](<https://example.com/banner.svg>)");
  });

  it("removes bot comments and empty details wrappers without leaving display chunks", () => {
    const document: MarkdownNode = {
      type: "document",
      children: [
        { type: "html_block", content: "<!-- generated bot metadata -->" },
        { type: "html_block", content: "<details>" },
        { type: "heading", level: 2, children: [{ type: "text", content: "Walkthrough" }] },
        { type: "html_block", content: "</details>" },
      ],
    };
    const result = nativeMarkdownWithHtml(document, () => {
      throw new Error("Empty HTML must not be parsed");
    });
    expect(result.children).toEqual([document.children![2]]);
    expect(nativeMarkdownDocumentChunks(result)).toHaveLength(1);
    expect(markdownHtmlContent("<summary>Walkthrough</summary>").trim()).toBe("**Walkthrough**");
  });

  it("keeps literal HTML code examples and gives HTML image fragments unique chunk keys", () => {
    const code: MarkdownNode = {
      type: "code_block",
      content: '<img src="literal.png">',
      language: "html",
    };
    const document: MarkdownNode = {
      type: "document",
      children: [
        code,
        { type: "html_block", content: '<img src="one.png">' },
        { type: "html_block", content: '<img src="two.png">' },
      ],
    };
    const result = nativeMarkdownWithHtml(document, (content) => ({
      type: "document",
      children: [
        {
          type: "paragraph",
          beg: 0,
          end: content.length,
          children: [{ type: "image", href: content, beg: 0 }],
        },
      ],
    }));
    expect(result.children![0]).toBe(code);
    const keys = nativeMarkdownDocumentChunks(result).map((chunk) => chunk.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(result.children![1]?.beg).toBeUndefined();
  });
});
