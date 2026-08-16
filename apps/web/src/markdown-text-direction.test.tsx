import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vite-plus/test";

import { rehypeAutoTextDirection } from "./markdown-text-direction";

function renderMarkdown(markdown: string): string {
  return renderToStaticMarkup(
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeAutoTextDirection]}>
      {markdown}
    </ReactMarkdown>,
  );
}

describe("rehypeAutoTextDirection", () => {
  it("marks each text block so the browser reads its own direction", () => {
    const html = renderMarkdown(`# مرحبا

مرحبا بالعالم

Hello world

- عنصر
- item`);

    expect(html).toContain('<h1 dir="auto">مرحبا</h1>');
    expect(html).toContain('<p dir="auto">مرحبا بالعالم</p>');
    expect(html).toContain('<p dir="auto">Hello world</p>');
    expect(html).toContain('<li dir="auto">عنصر</li>');
    expect(html).toContain('<li dir="auto">item</li>');
  });

  it("tags only the outermost block, since auto skips dir-bearing descendants", () => {
    const html = renderMarkdown(`> مرحبا بالعالم

- عنصر

  فقرة ثانية`);

    // The quote reads its own direction; a tagged paragraph inside would blind it.
    expect(html).toContain('<blockquote dir="auto">');
    expect(html).toContain("<p>مرحبا بالعالم</p>");
    // Lists never take a `dir` of their own, so each item keeps one.
    expect(html).not.toContain("<ul dir=");
    expect(html).toContain('<li dir="auto">');
    expect(html).toContain("<p>عنصر</p>");
  });

  it("lets a nested list item read its own direction, not its parent's", () => {
    const html = renderMarkdown(`- عنصر عربي
  - English child`);

    expect(html).toContain('<li dir="auto">عنصر عربي');
    expect(html).toContain('<li dir="auto">English child</li>');
  });

  it("keeps a list-only quote's items untagged, so the rail still has text to read", () => {
    const html = renderMarkdown(`> - عنصر
> - عنصر آخر`);

    expect(html).toContain('<blockquote dir="auto">');
    expect(html).not.toContain("<li dir=");
  });

  it("marks only the lists that hold a right-to-left item, so the marker has a gutter", () => {
    expect(renderMarkdown("- عنصر\n- item")).toContain('<ul data-rtl-item="">');
    expect(renderMarkdown("1. عنصر")).toContain('<ol data-rtl-item="">');
    // An all-English list keeps the end side flush with the text around it.
    expect(renderMarkdown("- item\n- another")).toContain("<ul>");
    // Only the nested list carries the Arabic item, so only it gets the gutter.
    const nested = renderMarkdown("- item\n  - عنصر");
    expect(nested).toContain('<ul>\n<li dir="auto">item');
    expect(nested).toContain('<ul data-rtl-item="">');
  });

  it("leaves code and layout containers alone", () => {
    const html = renderMarkdown(`\`\`\`ts
const مرحبا = 1;
\`\`\`

| a | ب |
| - | - |
| 1 | ٢ |`);

    expect(html).toContain("<pre><code");
    expect(html).not.toContain('<pre dir="auto"');
    expect(html).not.toContain('<table dir="auto"');
    expect(html).toContain('<th dir="auto">ب</th>');
    expect(html).toContain('<td dir="auto">٢</td>');
  });
});
