import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vite-plus/test";

import { remarkGithubAlerts } from "./markdown-github-alerts";

function renderMarkdown(markdown: string): string {
  return renderToStaticMarkup(
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkGithubAlerts]}>{markdown}</ReactMarkdown>,
  );
}

describe("remarkGithubAlerts", () => {
  it("tags a quote whose first line is a marker, and drops the marker line", () => {
    const html = renderMarkdown("> [!NOTE]\n> The content of the note.");

    expect(html).toContain('data-alert="note"');
    expect(html).not.toContain("[!NOTE]");
    expect(html).toContain("The content of the note.");
  });

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

  it("reads the marker case-insensitively, normalizing the kind", () => {
    const html = renderMarkdown("> [!important]\n> Read this.");

    expect(html).toContain('data-alert="important"');
  });

  it("leaves a quote alone when the marker shares its line with anything else", () => {
    const html = renderMarkdown("> [!NOTE] an ordinary quote");

    expect(html).not.toContain("data-alert");
    expect(html).toContain("[!NOTE] an ordinary quote");
  });

  it("leaves an unknown marker as the text it is", () => {
    const html = renderMarkdown("> [!DANGER]\n> Not one of GitHub's.");

    expect(html).not.toContain("data-alert");
    expect(html).toContain("[!DANGER]");
  });
});
