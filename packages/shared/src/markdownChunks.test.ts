import { describe, expect, it } from "vite-plus/test";

import { splitMarkdown } from "./markdownChunks.ts";

const splitLargeMarkdown = (text: string, targetChars?: number) =>
  splitMarkdown(text, targetChars).chunks;

const starts = (text: string) =>
  splitLargeMarkdown(text, 1).map((chunk) => chunk.text.split("\n")[0]);

describe("splitMarkdown", () => {
  it("cuts only where a new top-level block starts, and keeps every byte", () => {
    const text = [
      "# Title",
      "Intro paragraph",
      "",
      "- item one",
      "",
      "  continued item",
      "- item two",
      "",
      "2. ordered",
      "",
      "```md",
      "# not a heading",
      "",
      "Not a paragraph",
      "```",
      "",
      "> quote",
      "",
      "Closing paragraph",
      "## Next",
      "---",
      "",
      "| a | b |",
    ].join("\n");
    const chunks = splitLargeMarkdown(text, 1);
    expect(chunks.map((chunk) => chunk.text).join("\n")).toBe(text);
    expect(chunks.reduce((sum, chunk) => sum + chunk.lines, 0)).toBe(text.split("\n").length);
    expect(starts(text)).toEqual([
      "# Title",
      "```md",
      "> quote",
      "Closing paragraph",
      "## Next",
      "| a | b |",
    ]);
  });

  it("keeps a fence open until a matching closer", () => {
    const text = ["````", "```", "", "# inside", "````", "", "after"].join("\n");
    expect(starts(text)).toEqual(["````", "after"]);
  });

  it("keeps HTML blocks and display math open across blank lines", () => {
    const text = [
      "<!--",
      "",
      "# hidden",
      "-->",
      "",
      "$$",
      "",
      "Inside math",
      "$$",
      "",
      "<pre>",
      "",
      "Preformatted",
      "</pre>",
      "",
      "<!-- one line -->",
      "",
      "<div>",
      "# literal",
      "</div>",
      "",
      "<details>",
      "<summary>Answer</summary>",
      "",
      "Inside details",
      "",
      "</details>",
      "",
      "<table><tr><td>",
      "",
      "```ts",
      "inside a cell",
      "```",
      "",
      "</td></tr></table>",
      "",
      '<ol start="10">',
      "",
      "<li>one</li>",
      "",
      "<li>two</li>",
      "",
      "</ol>",
      "",
      "```html",
      "<details>",
      "```",
      "",
      "after",
    ].join("\n");
    expect(starts(text)).toEqual(["<!--", "```html", "after"]);
    const multiline = [
      "<details",
      '  class="faq"><!-- </details> -->',
      "",
      "Inside details",
      "",
      "</details>",
      "",
      "after",
    ].join("\n");
    expect(starts(multiline)).toEqual(["<details", "after"]);
    const unclosed = ["<details>", "", "x".repeat(32 * 1024), "", "after"].join("\n");
    expect(starts(unclosed)).toEqual(["<details>", "after"]);
  });

  it("treats an autolink line as a paragraph, so a following fence still opens", () => {
    const text = ["<https://example.com>", "```md", "", "# literal", "```", "", "after"].join("\n");
    expect(starts(text)).toEqual(["<https://example.com>", "after"]);
  });

  it("waits for the target size before cutting", () => {
    const text = ["# a", "", "b", "", "# c", "", "d"].join("\n");
    expect(splitLargeMarkdown(text, 6).map((chunk) => chunk.text)).toEqual([
      "# a\n\nb\n",
      "# c\n\nd",
    ]);
  });

  it("keeps leading frontmatter in the first piece", () => {
    const text = ["---", "title: x", "", "# not a heading", "---", "", "# Heading"].join("\n");
    expect(starts(text)).toEqual(["---", "# Heading"]);
  });

  it("collects link definitions outside code so every piece can resolve them", () => {
    const text = [
      "[![badge][b]][site]",
      "",
      "```md",
      "[fake]: /not-a-definition",
      "```",
      "",
      "Paragraph",
      "[inline]: /continues-the-paragraph",
      "",
      "[site]: https://example.com",
      "[b]: https://example.com/badge.svg 'Badge'",
      "[^note]: a footnote",
      "",
      '[x]: /url "title" is paragraph text',
      "",
      "# Heading",
      "[h]: /after-heading",
      "",
      "---",
      "[t]: /after-break",
      "",
      "===",
      "[p]: /paragraph-text",
    ].join("\n");
    expect(splitMarkdown(text).definitions).toBe(
      "[site]: https://example.com\n[b]: https://example.com/badge.svg 'Badge'\n[h]: /after-heading\n[t]: /after-break",
    );
  });
});
