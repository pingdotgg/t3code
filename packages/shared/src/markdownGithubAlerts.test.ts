import { toHtml } from "hast-util-to-html";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { type PluggableList, unified } from "unified";
import { describe, expect, it } from "vite-plus/test";

import { remarkGithubAlerts } from "./markdownGithubAlerts.ts";

const processor = unified()
  .use(remarkParse)
  .use([remarkGfm, remarkGithubAlerts] satisfies PluggableList)
  .use(remarkRehype, { allowDangerousHtml: true });

function renderMarkdown(markdown: string): string {
  return toHtml(processor.runSync(processor.parse(markdown), markdown), {
    allowDangerousHtml: true,
  });
}

describe("remarkGithubAlerts", () => {
  it("keeps content that follows a marker-only paragraph", () => {
    const html = renderMarkdown("> [!WARNING]\n>\n> ### A heading\n>\n> And a paragraph.");

    expect(html).toContain('data-alert="warning"');
    expect(html).not.toContain("[!WARNING]");
    expect(html).toContain("A heading");
    expect(html).toContain("And a paragraph.");
  });

  it("tags a quote whose next line opens with an inline node rather than text", () => {
    const html = renderMarkdown("> [!NOTE]\n> **Medium Risk** Changes live transcript routing.");

    expect(html).toContain('data-alert="note"');
    expect(html).not.toContain("[!NOTE]");
    expect(html).toContain("<strong>Medium Risk</strong>");
    expect(html).toContain("Changes live transcript routing.");
  });

  it("leaves a quote alone when the marker shares its line with anything else", () => {
    const html = renderMarkdown("> [!NOTE] an ordinary quote");

    expect(html).not.toContain("data-alert");
    expect(html).toContain("[!NOTE] an ordinary quote");
  });
});
