import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { describe, expect, it } from "vite-plus/test";

import { remarkRewriteWindowsFileLinks, rewriteMarkdownFileUriHref } from "./markdown-links";

const sanitizeSchema = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "file"],
  },
} satisfies Parameters<typeof rehypeSanitize>[0];

function renderMarkdown(markdown: string): string {
  return renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={[remarkRewriteWindowsFileLinks]}
      rehypePlugins={[[rehypeSanitize, sanitizeSchema]]}
      urlTransform={(href) => rewriteMarkdownFileUriHref(href) ?? defaultUrlTransform(href)}
    >
      {markdown}
    </ReactMarkdown>,
  );
}

describe("Windows markdown file link rendering", () => {
  it("preserves a drive-path href through HTML sanitization", () => {
    const path = "C:/Users/mike/dev-stuff/t3code/apps/web/src/markdown-links.ts";

    expect(renderMarkdown(`[markdown-links.ts](${path}) is open above.`)).toContain(
      `<a href="${path}">markdown-links.ts</a>`,
    );
  });

  it("canonicalizes a backslash drive-path href through HTML sanitization", () => {
    const path = "C:\\Users\\mike\\dev-stuff\\t3code\\apps\\web\\src\\markdown-links.ts";

    expect(renderMarkdown(`[markdown-links.ts](${path}) is open above.`)).toContain(
      '<a href="C:/Users/mike/dev-stuff/t3code/apps/web/src/markdown-links.ts">markdown-links.ts</a>',
    );
  });

  it("percent-encodes a unicode drive-path href through HTML sanitization", () => {
    const path = "C:/Users/mike/dev-stuff/文档/apps/web/src/markdown-links.ts";

    expect(renderMarkdown(`[markdown-links.ts](${path}) is open above.`)).toContain(
      '<a href="C:/Users/mike/dev-stuff/%E6%96%87%E6%A1%A3/apps/web/src/markdown-links.ts">markdown-links.ts</a>',
    );
  });

  it("still removes unsafe schemes", () => {
    expect(renderMarkdown("[unsafe](javascript:alert(1))")).not.toContain("href=");
  });
});
