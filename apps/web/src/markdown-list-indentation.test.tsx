import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vite-plus/test";

import { remarkNormalizeListItemIndentation } from "./markdown-list-indentation";

function renderMarkdown(markdown: string): string {
  return renderToStaticMarkup(
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkNormalizeListItemIndentation]}>
      {markdown}
    </ReactMarkdown>,
  );
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
    expect(html).toContain("<li>step.request.body = &quot;&lt;redacted&gt;&quot;;</li>");
  });

  it("parses inline markdown in recovered list content", () => {
    const html = renderMarkdown(
      "-       **important** [docs](https://example.com) use `inline code`, not ~~plain text~~",
    );

    expect(html).toContain("<strong>important</strong>");
    expect(html).toContain('<a href="https://example.com">docs</a>');
    expect(html).toContain("<code>inline code</code>");
    expect(html).toContain("<del>plain text</del>");
    expect(html).not.toContain("**important**");
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

  it("preserves same-line code blocks without excess indentation", () => {
    const html = renderMarkdown("-     const value = 1;");

    expect(html).toContain("<pre><code>const value = 1;");
  });
});
