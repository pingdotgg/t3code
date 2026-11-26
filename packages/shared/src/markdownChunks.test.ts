import { describe, expect, it } from "vite-plus/test";

import { toHtml } from "hast-util-to-html";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

import {
  LARGE_MARKDOWN_CHUNK_MAX_CHARS,
  splitMarkdown,
  withMarkdownDefinitions,
} from "./markdownChunks.ts";
import { taskListMarkerOffset } from "./markdownTaskEdits.ts";

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

  it("treats nonbreaking spaces as content rather than fence suffixes or blank lines", () => {
    const fence = ["```md", "x".repeat(4100), "```\u00a0", "# literal", "```"].join("\n");
    expect(splitLargeMarkdown(fence)).toHaveLength(1);

    const prose = ["*" + "x".repeat(4100), "\u00a0", "more*"].join("\n");
    expect(splitLargeMarkdown(prose)).toHaveLength(1);

    const htmlBlock = ["<div>", "x".repeat(4100), "\u00a0", "# literal", "</div>"].join("\n");
    expect(splitLargeMarkdown(htmlBlock)).toHaveLength(1);
  });

  it("still closes fences and recognizes blank lines with ASCII spaces, tabs, and CRLF", () => {
    const fence = ["```md", "x".repeat(4100), "``` \t", "# heading"].join("\r\n");
    expect(splitLargeMarkdown(fence).map((chunk) => chunk.text.split("\r\n")[0])).toEqual([
      "```md",
      "# heading",
    ]);

    const prose = ["a".repeat(4100), " \t", "next paragraph"].join("\r\n");
    expect(splitLargeMarkdown(prose).map((chunk) => chunk.text.split("\r\n")[0])).toEqual([
      "a".repeat(4100),
      "next paragraph",
    ]);

    const htmlBlock = ["<div>", "x".repeat(4100), " \t", "# heading"].join("\r\n");
    expect(splitLargeMarkdown(htmlBlock).map((chunk) => chunk.text.split("\r\n")[0])).toEqual([
      "<div>",
      "# heading",
    ]);
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
      '<p class="lead">text',
      "# literal",
      "</p>",
      "",
      '<span class="box">',
      "# literal",
      "</span>",
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

  it("treats an autolink or inline HTML line as a paragraph, so a following fence still opens", () => {
    const text = [
      "<https://example.com>",
      "```md",
      "",
      "# literal",
      "```",
      "",
      "<b>bold</b> text",
      "```md",
      "",
      "# literal",
      "```",
      "",
      "after",
    ].join("\n");
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

  it("cuts after a leading horizontal rule with no frontmatter closer", () => {
    const md =
      "---\n\n" +
      Array.from({ length: 300 }, (_, i) => `## Part ${i}\n${"a".repeat(450)}`).join("\n\n");
    const { chunks } = splitMarkdown(md);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.text.length <= LARGE_MARKDOWN_CHUNK_MAX_CHARS)).toBe(true);
    expect(chunks.map((chunk) => chunk.text).join("\n")).toBe(md);
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
    expect(splitMarkdown("---\n[rule]: /after-leading-rule\n\n# A").definitions).toBe(
      "[rule]: /after-leading-rule",
    );
    const unbalanced = [
      "[x]: /docs/example)",
      "[after]: /continues-paragraph",
      "",
      "[open]: /docs/example(",
      "",
      "[bs]: /docs/example\\\\)",
      "",
      "[balanced]: /docs/example(a(b))",
      "[escaped]: /docs/example\\)",
      "[angle]: </docs/example)>",
    ];
    expect(splitMarkdown(unbalanced.join("\n")).definitions).toBe(
      "[balanced]: /docs/example(a(b))\n[escaped]: /docs/example\\)\n[angle]: </docs/example)>",
    );
  });
});

describe("withMarkdownDefinitions", () => {
  const html = (text: string) => {
    const processor = unified().use(remarkParse).use(remarkRehype);
    return toHtml(processor.runSync(processor.parse(text)));
  };

  it("keeps the first document definition ahead of later chunk definitions", () => {
    const text = "[id]: /first\n\n" + "x".repeat(4100) + "\n\n# Next\n[id]: /later\n\n[id]";
    const { chunks, definitions } = splitMarkdown(text);
    expect(html(text)).toContain('href="/first"');
    expect(chunks).toHaveLength(2);
    expect(html(withMarkdownDefinitions(chunks[1]!.text, definitions))).toContain('href="/first"');
    expect(chunks.map((chunk) => chunk.text).join("\n")).toBe(text);
  });

  it("keeps frontmatter hidden and task offsets shifted by exactly the prefix", () => {
    const text = "\uFEFF---\r\ntitle: hidden\r\n---\r\n\r\n[ref]: /x\r\n\r\n- [ ] task";
    const { definitions } = splitMarkdown(text);
    const rendered = withMarkdownDefinitions(text, definitions);
    expect(html(rendered)).not.toContain("hidden");
    const list = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .parse(rendered)
      .children.find((node) => node.type === "list");
    const marker = taskListMarkerOffset(rendered, list!.position!.start.offset!);
    expect(marker! - (definitions.length + 2)).toBe(text.indexOf("[ ]"));
  });

  it("keeps shared definitions out of a trailing unclosed code fence", () => {
    const text = "[ref]: /dst\n\n```text\nshown";
    const { definitions } = splitMarkdown(text);
    expect(html(withMarkdownDefinitions(text, definitions))).toBe(html(text));
  });
});
