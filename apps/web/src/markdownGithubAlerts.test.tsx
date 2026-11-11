import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vite-plus/test";

import { remarkGithubAlerts } from "@t3tools/shared/markdownGithubAlerts";

function renderMarkdown(markdown: string): string {
  return renderToStaticMarkup(
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkGithubAlerts]}>{markdown}</ReactMarkdown>,
  );
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
