import { describe, expect, it } from "vite-plus/test";

import { toHtml } from "hast-util-to-html";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

import {
  buildMarkdownFootnotesSection,
  findFootnoteRefChunkIndex,
  joinMarkdownChunks,
  LARGE_MARKDOWN_CHUNK_MAX_CHARS,
  prepareMarkdownChunk,
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

  it("splits CR-only Markdown into bounded chunks like LF and preserves line endings", () => {
    const cr = `first\r\r# ${"x\r\r# ".repeat(30_000)}end`;
    const lf = cr.replaceAll("\r", "\n");
    const crResult = splitMarkdown(cr);
    const lfResult = splitMarkdown(lf);

    expect(crResult.chunks.length).toBe(lfResult.chunks.length);
    expect(crResult.chunks.length).toBeGreaterThan(1);
    expect(
      crResult.chunks.every((chunk) => chunk.text.length <= LARGE_MARKDOWN_CHUNK_MAX_CHARS),
    ).toBe(true);
    expect(crResult.chunks.reduce((sum, chunk) => sum + chunk.lines, 0)).toBe(
      lfResult.chunks.reduce((sum, chunk) => sum + chunk.lines, 0),
    );
    expect(joinMarkdownChunks(crResult.chunks)).toBe(cr);
    const rendered = unified().use(remarkParse).use(remarkRehype);
    expect(toHtml(rendered.runSync(rendered.parse(crResult.chunks[1]!.text)))).toContain(
      "<h1>x</h1>",
    );

    const mixed = `---\rtitle: cr\r---\r\r[ref]: /cr-link\r\r\`\`\`md\r# inside fence\r\`\`\`\r\r<details>\r\r${"x".repeat(32 * 1024)}\r\r</details>\r\r# After [ref]\r\n\r\n- [ ] task`;
    const mixedResult = splitMarkdown(mixed);
    expect(mixedResult.definitions).toBe("[ref]: /cr-link");
    expect(mixedResult.chunks.map((chunk) => chunk.text.split(/\r\n?|\n/)[0])).toEqual([
      "---",
      "# After [ref]",
    ]);
    expect(joinMarkdownChunks(mixedResult.chunks)).toBe(mixed);
    const secondChunk = withMarkdownDefinitions(
      mixedResult.chunks[1]!.text,
      mixedResult.definitions,
    );
    const list = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .parse(secondChunk)
      .children.find((node) => node.type === "list");
    const marker = taskListMarkerOffset(secondChunk, list!.position!.start.offset!);
    const secondStart = mixedResult.chunks[0]!.text.length + 1;
    expect(secondStart + marker! - (mixedResult.definitions.length + 2)).toBe(mixed.indexOf("[ ]"));
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

  it("keeps the complete sample fence before a later oversized source chunk", () => {
    const example = ["```md", "Sample Markdown", "", "# Sample heading", "```"].join("\n");
    const preview = ["x".repeat(4200), "<span>", example, "More prose", "<span>"].join("\n");
    const oversized = "# Appendix\n" + "[link](/example) ".repeat(11_000);
    const { chunks } = splitMarkdown(preview + "\n" + oversized);
    expect(chunks.map((chunk) => chunk.text)).toEqual([preview, oversized]);
  });

  it.each(["===", "---", "***"])(
    "keeps HTML together after a long paragraph and %s",
    (boundary) => {
      const text = ["x".repeat(9000), boundary, "<span>", "# literal"].join("\n");
      expect(splitMarkdown(text).chunks.map((chunk) => chunk.text)).toEqual([text]);
    },
  );

  it.each([
    ["a fence", "```md", "```"],
    ["an HTML comment", "<!--", "-->"],
    ["display math", "$$", "$$"],
  ])("keeps %s intact after an ambiguous standalone tag", (_, open, close) => {
    const block = [open, "Sample Markdown", "", "# Sample heading", close].join("\n");
    const preview = ["x".repeat(9000), "<span>", block].join("\n");
    expect(splitMarkdown(preview).chunks.map((chunk) => chunk.text)).toEqual([preview]);
  });

  it("preserves an oversized ambiguous region for source display", () => {
    const oversized = ["x".repeat(LARGE_MARKDOWN_CHUNK_MAX_CHARS), "<span>", "# Heading"].join(
      "\n",
    );
    const next = "# Next";
    const text = oversized + "\n\n" + next;
    expect(splitMarkdown(text).chunks.map((chunk) => chunk.text)).toEqual([oversized + "\n", next]);
  });

  it.each([
    ["multiline math with backticks", ["$$", "```", "$$", " # Heading"]],
    ["single-line display math", ["$$x$$"]],
  ])("keeps standalone HTML intact after %s", (_, math) => {
    const text = ["x".repeat(4200), "<span>", ...math, "<span>", "# literal"].join("\n");
    expect(splitMarkdown(text).chunks.map((chunk) => chunk.text)).toEqual([text]);
  });

  it("can cut at a heading after a tag in a lazy quote continuation", () => {
    const quote = ["> " + "x".repeat(4200), "continued", "<span>"].join("\n");
    const heading = "# Next";
    expect(splitMarkdown(quote + "\n" + heading).chunks.map((chunk) => chunk.text)).toEqual([
      quote,
      heading,
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

  it.each([
    ["an ordered item whose content starts farther right", "10. Item\n\n", ""],
    ["an item padded to the next tab stop", "-\tItem\n\n", ""],
    ["a blockquote that ends the list", "- Item\n> quote\n", ""],
    ["an HTML comment that ends the list", "- Item\n<!-- note -->\n", ""],
    ["an HTML block that ends the list", "- Item\n<div>top level</div>\n\n", ""],
    ["a math block that ends the list", "- Item\n$$\nx\n$$\n", ""],
    ["an indented thematic break", "  - - -\n", ""],
    ["an empty list item", "-\n\n", "  "],
    ["an empty list item with trailing spaces", "-  \n\n", "  "],
    ["an empty list item followed by dedented prose", "-\nfoo\n", "  "],
  ])("collects definitions after a fence following %s", (_, beforeFence, definitionIndent) => {
    const definition = "[ref]: /target";
    const text = beforeFence + "  ```sh\n  example\n  ```\n" + definitionIndent + definition;
    expect(splitMarkdown(text).definitions).toBe(definition);
  });

  it.each([
    ["nested markers on one line", "- - ```\n    code\n    ```"],
    ["a line of many nested markers", "- ".repeat(70_000) + "x"],
    ["a heading in a list item", "- # Heading\n  2. Item\n     ```\n     code\n        ```"],
    ["a lazy ordered marker", "- outer\n  - inner\n2. lazy\n    ```\n       ```"],
  ])("collects a list item definition after %s", (_, list) => {
    const definition = "[ref]: /target";
    expect(splitMarkdown(`${list}\n\n  ${definition}`).definitions).toBe(definition);
  });

  it.each([
    ["after a list fence", ["- Item", "  ```", "  code", "```", "[ref]: /fake", "```"]],
    ["after a paragraph", ["Paragraph", "2. continuation", "   ```", "[ref]: /fake", "   ```"]],
    [
      "in a parent item after a nested item",
      ["- outer", "  - inner", "    ```", "  ```", "  [ref]: /fake", "  ```"],
    ],
  ])("keeps definitions inside a top-level fence %s literal", (_, lines) => {
    expect(splitMarkdown(lines.join("\n")).definitions).toBe("");
  });

  it.each(["", " ", "  ", "   "])(
    "collects link definitions outside code with fence indent %j",
    (indent) => {
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
    },
  );
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

  it.each([
    ["a wrapped label with an inline destination", "[release\nnotes]: /first", "/first", ""],
    ["a wrapped label with a next-line destination", "[release\nnotes]:\n  /first", "/first", ""],
    [
      "a title on the next line of the preceding definition",
      '[other]: /other\n  "Other"\n[release notes]: /first',
      "/first",
      "",
    ],
    [
      "a title starting on the destination line",
      '[release notes]: /first "First\n  release"',
      "/first",
      'title="First\nrelease"',
    ],
    [
      "a destination ending in a nonbreaking space",
      "[release notes]:\n  /first\u00a0",
      "/first%C2%A0",
      "",
    ],
  ])("preserves the first reference with %s", (_, first, href, title) => {
    const text = `${first}\n\n${"x".repeat(4100)}\n\n# Next\n[release notes]: /later\n\n[Release][release notes]`;
    const { chunks, definitions } = splitMarkdown(text);
    expect(chunks).toHaveLength(2);
    const rendered = html(withMarkdownDefinitions(chunks[1]!.text, definitions));
    expect(rendered).toContain(`href="${href}"`);
    if (title) expect(rendered).toContain(title);
  });

  it("shares a wrapped label at the Markdown length limit with an escaped bracket", () => {
    const definition = `[${"a".repeat(995)}\\]\nct]: /first`;
    expect(splitMarkdown(definition).definitions).toBe(definition);
  });

  it("leaves oversized titles with their source definitions", () => {
    const title = "t".repeat(16 * 1024);
    const text = `[id]\n\n[id]:\n  /first\n  "${title}"\n\n# Next\n[ID]: /later\n\n[id]`;
    const { chunks, definitions } = splitMarkdown(text);
    expect(chunks).toHaveLength(2);
    const first = html(withMarkdownDefinitions(chunks[0]!.text, definitions));
    expect(first).toContain('href="/first"');
    expect(first).toContain(`title="${title}"`);
  });

  it.each(["", '" trailing text', '\\"'])(
    "shares a complete definition before a long quote-led paragraph ending in %j",
    (suffix) => {
      const text = `[id]:\n  /first\n  "${"x".repeat(16 * 1024)}${suffix}\n\n# Next\n[id]: /later\n\n[id]`;
      const { chunks, definitions } = splitMarkdown(text);
      expect(chunks).toHaveLength(2);
      const rendered = html(withMarkdownDefinitions(chunks[1]!.text, definitions));
      expect(rendered).toContain('href="/first"');
    },
  );

  it.each([
    ["inline links", "[a](/x)".repeat(2000), "\n\n", 64],
    ["link-like text separated by thematic breaks", "[note] text\n***", "\n", 2000],
    ["invalid definitions separated by thematic breaks", "[note]: /invalid)\n***", "\n", 2000],
  ])("keeps long runs of %s out of shared definitions", (_, block, separator, count) => {
    const text = Array.from({ length: count }, () => block).join(separator);
    const { chunks, definitions } = splitMarkdown(text);
    expect(definitions).toBe("");
    expect(chunks.map((chunk) => chunk.text).join("\n")).toBe(text);
  });

  it("keeps a display math opener and its contents out of shared definitions", () => {
    const text = "[actual]\n\n[unused]:\n$$\n\n[actual]: /wrong\n\n$$\n\n[actual]: /right";
    const { chunks, definitions } = splitMarkdown(text, 1);
    expect(html(withMarkdownDefinitions(chunks[0]!.text, definitions))).toContain('href="/right"');
    expect(definitions).toBe("[actual]: /right");
    expect(chunks.map((chunk) => chunk.text).join("\n")).toBe(text);
  });

  it("collects a long run of titled references within the shared definition budget", () => {
    const references = Array.from({ length: 2000 }, (_, index) => `[r${index}]:\n  /url "Title"`);
    const source = references.join("\n");
    const { definitions } = splitMarkdown(source);
    expect(definitions).toBe(source.slice(0, definitions.length));
    expect(definitions).toContain(references[500]);
    expect(definitions.length).toBeLessThanOrEqual(16 * 1024);
    expect(definitions).not.toContain("[r1999]");
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

describe("chunked Markdown footnotes", () => {
  it.each([{ renderedChunkSize: LARGE_MARKDOWN_CHUNK_MAX_CHARS }, { renderedChunkSize: 0 }])(
    "counts only rendered references with a $renderedChunkSize-character sibling",
    ({ renderedChunkSize }) => {
      const ref = "[^note]";
      const rendered = renderedChunkSize
        ? `${"a".repeat(renderedChunkSize - ref.length - 1)}${ref}\n\n`
        : "";
      const oversized = `${"b".repeat(LARGE_MARKDOWN_CHUNK_MAX_CHARS - ref.length)}${ref}\n\n`;
      const definition = "[^note]: Shared explanation.";
      const { definitions, footnotes } = splitMarkdown(
        `${rendered}${oversized}# Appendix\n\n${definition}`,
        1,
      );
      const section = buildMarkdownFootnotesSection(definitions, footnotes);
      expect(section?.text ?? null).toBe(renderedChunkSize ? `${ref}\n\n${definition}` : null);
    },
  );

  it("keeps footnotes undefined for single-chunk files and unreferenced definitions", () => {
    const small = "A footnote reference.[^1]\n\n[^1]: The footnote text.\n";
    expect(splitMarkdown(small).footnotes).toBeUndefined();

    const unreferenced = [
      "Intro paragraph.",
      "",
      ...Array.from({ length: 40 }, (_, i) => `Paragraph ${i}. ${"Lorem ipsum. ".repeat(12)}`),
      "",
      "[^unused]: Never referenced.",
    ].join("\n");
    const split = splitMarkdown(unreferenced);
    expect(split.chunks.length).toBeGreaterThan(1);
    expect(split.footnotes).toBeUndefined();
  });

  it("collects footnote definitions and per-chunk references across pieces", () => {
    const paragraphs = Array.from(
      { length: 60 },
      (_, i) =>
        `Paragraph ${i}. ${"Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(2)}`,
    );
    const text = [
      "A footnote reference.[^1] Escaped \\[^1], code `[^1]`, [link](https://example.com/[^1]).",
      "",
      ...paragraphs.slice(0, 35).flatMap((p) => [p, ""]),
      "Second ref[^note] and repeat[^1].",
      "",
      ...paragraphs.slice(35).flatMap((p) => [p, ""]),
      "```md",
      "[^fake]: inside code fence",
      "```",
      "",
      "[^1]: The footnote text.",
      "    Second paragraph of footnote 1.",
      "",
      "[^note]: First note definition.",
      "",
      "[^note]: Duplicate ignored.",
    ].join("\n");

    const { chunks, definitions, footnotes } = splitMarkdown(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.text).join("\n")).toBe(text);
    expect(footnotes).toBeDefined();
    expect(footnotes!.stubs).toBe("[^1]: .\n[^note]: .");
    expect(footnotes!.definitions).toBe(
      "[^1]: The footnote text.\n    Second paragraph of footnote 1.\n\n[^note]: First note definition.",
    );
    expect(footnotes!.chunkRefs.flat()).toEqual(["1", "note", "1"]);

    const firstRefChunk = footnotes!.chunkRefs.findIndex((refs) => refs.length > 0);
    const secondRefChunk = footnotes!.chunkRefs.findIndex(
      (refs, index) => index > firstRefChunk && refs.length > 0,
    );
    expect(firstRefChunk).toBe(0);
    expect(secondRefChunk).toBeGreaterThan(0);

    const preparedFirst = prepareMarkdownChunk(
      chunks[firstRefChunk]!.text,
      firstRefChunk,
      definitions,
      footnotes,
    );
    expect(preparedFirst.footnotesMode).toBe("omit");

    const preparedSecond = prepareMarkdownChunk(
      chunks[secondRefChunk]!.text,
      secondRefChunk,
      definitions,
      footnotes,
    );
    expect(preparedSecond.footnotesMode).toBe("omit-seeded");
    expect(preparedSecond.text).toContain("[^1]\n\n");

    const section = buildMarkdownFootnotesSection(definitions, footnotes)?.text;
    expect(section).toContain("[^1] [^note] [^1]");
    expect(section).toContain("Second paragraph of footnote 1.");
    expect(section).not.toContain("Duplicate ignored.");

    expect(findFootnoteRefChunkIndex(footnotes!, 1, 1)).toBe(firstRefChunk);
    expect(findFootnoteRefChunkIndex(footnotes!, 2, 1)).toBe(secondRefChunk);
    expect(findFootnoteRefChunkIndex(footnotes!, 1, 2)).toBe(secondRefChunk);
    expect(findFootnoteRefChunkIndex(footnotes!, 1, 3)).toBeNull();
  });

  it("keeps task list offsets exact when footnote seed prefix is prepended", () => {
    const filler = Array.from({ length: 40 }, (_, i) => `Section ${i} ${"x".repeat(120)}`).join(
      "\n\n",
    );
    const text = [
      "[site]: https://example.com",
      "",
      "Lead[^1] with [site].",
      "",
      filler,
      "",
      "- [ ] task in chunk with seeded ref[^1]",
      "",
      "[^1]: Footnote body.",
    ].join("\n");
    const { chunks, definitions, footnotes } = splitMarkdown(text);
    const taskChunkIndex = chunks.findIndex((chunk) => chunk.text.includes("- [ ] task"));
    expect(taskChunkIndex).toBeGreaterThan(0);
    const prepared = prepareMarkdownChunk(
      chunks[taskChunkIndex]!.text,
      taskChunkIndex,
      definitions,
      footnotes,
    );
    const list = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .parse(prepared.text)
      .children.find((node) => node.type === "list");
    const marker = taskListMarkerOffset(prepared.text, list!.position!.start.offset!);
    let chunkStart = 0;
    for (let i = 0; i < taskChunkIndex; i++) {
      chunkStart += chunks[i]!.text.length + 1;
    }
    expect(chunkStart + marker! - prepared.offsetShift).toBe(text.indexOf("[ ]"));
  });

  it("counts references followed by ':' or '(', skips inline math, and stays linear", () => {
    const filler = Array.from(
      { length: 40 },
      (_, i) => `Paragraph ${i}. ${"word ".repeat(25)}`,
    ).join("\n\n");
    const text = [
      "As noted[^a]: see this. Quote.[^b](emphasis added) and [^c](https://example.com). Math $x[^a]y$.",
      "",
      // Unclosed marks rescanned from each opener took seconds; nested quotes took minutes.
      `${"> ".repeat(40)}x[^b]: t`,
      "",
      `[^c] ${"](( ".repeat(20000)}`,
      "",
      `[^a] ${"$x ".repeat(20000)}`,
      "",
      `[^c] ${"<!-- ](<".repeat(16_000)}`,
      "",
      "Literal ](see[^b]) but [link](x[^a]) is a destination.",
      "",
      filler,
      "",
      "[^a]: First note.",
      "[^b]: Second note.",
      "[^c]: Third note.",
    ].join("\n");

    const { chunks, footnotes } = splitMarkdown(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(footnotes?.chunkRefs.flat()).toEqual(["a", "b", "c", "b", "c", "a", "c", "b"]);
  });

  it("falls back when footnote definitions exceed the shared cap", () => {
    const sections = Array.from(
      { length: 400 },
      (_, i) => `Paragraph ${i} referencing [^f${i}].\n\n[^f${i}]: ${"note text ".repeat(20)}`,
    ).join("\n\n");
    const split = splitMarkdown(sections);
    expect(split.chunks.length).toBeGreaterThan(1);
    expect(split.footnotes).toBeUndefined();
  });

  it("separates stub footnote definitions from a chunk starting with indented code", () => {
    const filler = Array.from({ length: 40 }, (_, i) => `Section ${i} ${"x".repeat(120)}`).join(
      "\n\n",
    );
    const text = [
      "    indented()",
      "",
      "Ref[^1].",
      "",
      filler,
      "",
      "    code[^a]",
      "",
      "- item",
      "",
      "    item text[^2]",
      "",
      "[^1]: Footnote body.",
      "",
      "[^a]: Literal in code.",
      "",
      "[^2]: In a list item.",
    ].join("\n");

    const { chunks, definitions, footnotes } = splitMarkdown(text);
    const prepared = prepareMarkdownChunk(chunks[0]!.text, 0, definitions, footnotes);
    expect(prepared.footnotesMode).toBe("omit");
    expect(prepared.text).toContain("<!-- -->\n\n    indented()");
    expect(footnotes?.chunkRefs.flat()).toEqual(["1", "2"]);
    // The unreferenced `[^a]` definition is dropped when the section renders.
    const section = buildMarkdownFootnotesSection(definitions, footnotes)!.text;
    expect(section.startsWith("[^1] [^2]\n\n")).toBe(true);
  });
});
