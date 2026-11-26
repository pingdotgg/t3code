import { toHtml } from "hast-util-to-html";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { type PluggableList, unified } from "unified";
import { describe, expect, it } from "vite-plus/test";

import { remarkCodexDirectives } from "./codexMarkdownDirectives.ts";
import { remarkNormalizeListItemIndentation } from "./markdownListIndentation.ts";
import { remarkEnableLeadingWhitespace } from "./markdownLeadingWhitespace.ts";

const processor = unified()
  .use(remarkParse)
  .use([
    remarkGfm,
    remarkNormalizeListItemIndentation,
    remarkCodexDirectives,
  ] satisfies PluggableList)
  .use(remarkRehype, { allowDangerousHtml: true });

function renderMarkdown(markdown: string): string {
  return toHtml(processor.runSync(processor.parse(markdown), markdown), {
    allowDangerousHtml: true,
  });
}

describe("remarkNormalizeListItemIndentation", () => {
  it.each([
    ["-     \tfoo\n          bar", '<span data-leading-whitespace="">  </span>bar'],
    ["-        foo\n      \tbar", "\nbar"],
  ])("keeps continuation indentation aligned to tab stops: %j", (markdown, expected) => {
    const userProcessor = processor().use(remarkEnableLeadingWhitespace);
    const html = toHtml(userProcessor.runSync(userProcessor.parse(markdown), markdown));
    expect(html).toContain(expected);
  });

  it("renders a leading directive in over-indented list content", () => {
    expect(renderMarkdown('-       :codex-file-citation{path="src/a.ts"}')).toBe(
      '<ul>\n<li><a href="src/a.ts">a.ts</a></li>\n</ul>',
    );
  });

  it("renders same-line over-indented list content as list text", () => {
    const html = renderMarkdown(`why did you do this?

-       for (const step of rest.steps) {
-           if (step.request.body) {
-               step.request.body = "<redacted>";
-           }
-       }`);

    expect(html).not.toContain("<pre>");
    expect(html).toContain("<li>for (const step of rest.steps) {</li>");
    expect(html).toContain("<li>if (step.request.body) {</li>");
    expect(html).toContain('<li>step.request.body = "<redacted>";</li>');
  });

  it("preserves every recovered block separated by blank lines", () => {
    const html = renderMarkdown(`-       **first block**

        [second block](https://example.com)`);

    expect(html).toContain("<strong>first block</strong>");
    expect(html).toContain('<a href="https://example.com">second block</a>');
    expect(renderMarkdown("-       first\n\n        ```\n        \tcode\n        ```")).toContain(
      "<pre><code>\tcode\n</code></pre>",
    );
  });

  it("recursively normalizes lists in recovered tail blocks", () => {
    const html = renderMarkdown(`-       first block

        -       nested block`);

    expect(html).not.toContain("<pre>");
    expect(html).toContain("<li>nested block</li>");
  });

  it("preserves fenced code blocks within list items", () => {
    const html = renderMarkdown(`- \`\`\`ts
  const value = 1;
  \`\`\``);

    expect(html).toContain('<pre><code class="language-ts">const value = 1;');
  });

  it("preserves indented code blocks that start below a list marker", () => {
    const html = renderMarkdown(`-
      const value = 1;`);

    expect(html).toContain("<pre><code>const value = 1;");
  });
});
