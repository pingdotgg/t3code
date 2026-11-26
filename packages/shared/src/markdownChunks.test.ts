import { describe, expect, it } from "vite-plus/test";

import { LARGE_MARKDOWN_CHUNK_MAX_CHARS, splitMarkdown } from "./markdownChunks.ts";

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
    const head = ["<details>", "", "a".repeat(8 * 1024), "", ""].join("\n");
    const longLine = "x".repeat(LARGE_MARKDOWN_CHUNK_MAX_CHARS - head.length);
    expect(starts(head + longLine)).toEqual(["<details>"]);
    expect(starts(`${head}${longLine}x`)).toEqual(["<details>", `${longLine}x`]);
    expect(starts(`${head}\`\`\`json\n${longLine}\n\`\`\`\n\n</details>`)).toEqual([
      "<details>",
      "```json",
    ]);
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

  it.each([
    ["one space", " # References"],
    ["two spaces", "  ### References"],
    ["three spaces", "   ###### References"],
  ])("collects definitions after headings indented by %s without cutting there", (_, heading) => {
    const intro = "[Release notes][release]\n";
    const definition = "[release]: /releases";
    const appendix = ["## Appendix", heading, definition].join("\n");
    const result = splitMarkdown(`${intro}\n${appendix}`, 1);

    expect(result.definitions).toBe(definition);
    expect(result.chunks.map((chunk) => chunk.text)).toEqual([intro, appendix]);
  });

  it.each(["", " "])("collects link definitions outside code with fence indent %j", (indent) => {
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
      "",
      `${indent}\`\`\`sh`,
      "npm install",
      `${indent}\`\`\``,
      "[fence]: /after-fence",
      "~~~",
      "~~~",
      "Text after a fence",
      "[q]: /continues-the-paragraph",
      "",
      "$$",
      "x",
      "$$ trailing",
      "[math]: /inside-math",
      "",
      "<!-->",
      "```",
      "-->",
      "```",
      "[comment]: /after-a-closed-comment",
      "```",
      "[code]: /inside-a-fence-after-a-comment",
      "```",
      "",
      "- ```md",
      "  ~~~",
      "  ~~~",
      "  [list]: /inside-a-list-fence",
      "  ```",
    ].join("\n");
    expect(splitMarkdown(text).definitions).toBe(
      "[site]: https://example.com\n[b]: https://example.com/badge.svg 'Badge'\n[h]: /after-heading\n[t]: /after-break\n[fence]: /after-fence\n[comment]: /after-a-closed-comment",
    );
    const frontmatter = ["---", "title: x", "...", "[fm]: /after-frontmatter", "", "# A"];
    expect(splitMarkdown(frontmatter.join("\n")).definitions).toBe("[fm]: /after-frontmatter");
    const unclosed = ["---", ...Array<string>(1000).fill("text"), "[u]: /paragraph-text"];
    expect(splitMarkdown(unclosed.join("\n")).definitions).toBe("");
  });
});
