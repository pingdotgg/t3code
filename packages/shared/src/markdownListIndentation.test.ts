import { toHtml } from "hast-util-to-html";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { type PluggableList, unified } from "unified";
import { describe, expect, it } from "vite-plus/test";

import { remarkNormalizeListItemIndentation } from "./markdownListIndentation.ts";

const processor = unified()
  .use(remarkParse)
  .use([remarkGfm, remarkNormalizeListItemIndentation] satisfies PluggableList)
  .use(remarkRehype, { allowDangerousHtml: true });

function renderMarkdown(markdown: string): string {
  return toHtml(processor.runSync(processor.parse(markdown), markdown), {
    allowDangerousHtml: true,
  });
}

describe("remarkNormalizeListItemIndentation", () => {
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
