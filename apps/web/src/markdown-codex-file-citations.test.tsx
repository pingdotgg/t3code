import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import ChatMarkdown from "./components/ChatMarkdown";
import { extractCodexFileCitationPaths } from "./markdown-codex-file-citations";

const WORKING_DIRECTORY = "/Users/example/project";

function renderMessage(text: string, cwd = WORKING_DIRECTORY): string {
  return renderToStaticMarkup(<ChatMarkdown cwd={cwd} text={text} />);
}

describe("Codex file citations", () => {
  it("renders an artifact citation as the local file chip", () => {
    const html = renderMessage(
      'Created :codex-file-citation{path="/Users/example/project/output/report.docx" purpose="output"}.',
    );

    expect(html).toContain("chat-markdown-file-link");
    expect(html).toContain('href="/Users/example/project/output/report.docx"');
    expect(html).toContain(">report.docx</span>");
    expect(html).not.toContain("codex-file-citation");
  });

  it("resolves a relative path against the working directory, in either attribute order", () => {
    const html = renderMessage(':codex-file-citation{purpose="source" path="output/report.docx"}');

    expect(html).toContain("chat-markdown-file-link");
    expect(html).toContain('href="/Users/example/project/output/report.docx"');
  });

  it("keeps spaces, parentheses, and escaped quotes in the path", () => {
    const html = renderMessage(
      'See :codex-file-citation{path="/Users/example/project/out/final \\"v2\\" (a b).docx" purpose="output"}.',
    );

    expect(html).toContain('href="/Users/example/project/out/final &quot;v2&quot; (a b).docx"');
    expect(html).toContain(">final &quot;v2&quot; (a b).docx</span>");
  });

  it("links an artifact written outside the workspace", () => {
    const html = renderMessage(':codex-file-citation{path="/tmp/export.zip" purpose="output"}');

    expect(html).toContain("chat-markdown-file-link");
    expect(html).toContain('href="/tmp/export.zip"');
  });

  it("links a Windows path, whose drive letter would otherwise read as a URL scheme", () => {
    const html = renderMessage(
      ':codex-file-citation{path="C:/Users/me/report.docx" purpose="output"}',
      "C:/Users/me",
    );

    expect(html).toContain("chat-markdown-file-link");
    expect(html).toContain('href="C:/Users/me/report.docx"');
  });

  it("renders citations in chat-style messages, where single newlines are hard breaks", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd={WORKING_DIRECTORY}
        lineBreaks
        text={'Done:\n:codex-file-citation{path="/tmp/export.zip" purpose="output"}'}
      />,
    );

    expect(html).toContain("chat-markdown-file-link");
    expect(html).toContain('href="/tmp/export.zip"');
  });

  it("leaves a half-streamed directive as the text it is", () => {
    const html = renderMessage('Creating :codex-file-citation{path="/tmp/unfinished');

    expect(html).not.toContain("chat-markdown-file-link");
    expect(html).toContain(":codex-file-citation{path=&quot;/tmp/unfinished");
  });

  it("leaves directives inside code spans and code fences alone", () => {
    const html = renderMessage(
      '`:codex-file-citation{path="/tmp/inline.txt" purpose="output"}`\n\n' +
        '```text\n:codex-file-citation{path="/tmp/fenced.txt" purpose="output"}\n```',
    );

    expect(html).not.toContain("chat-markdown-file-link");
    expect(html).toContain(":codex-file-citation{path=&quot;/tmp/inline.txt&quot;");
    expect(html).toContain(":codex-file-citation{path=&quot;/tmp/fenced.txt&quot;");
  });

  it("leaves a directive whose path is not a local file alone", () => {
    const html = renderMessage(':codex-file-citation{path="https://example.com/report.pdf"}');

    expect(html).not.toContain("chat-markdown-file-link");
    expect(html).toContain(":codex-file-citation{path=");
  });

  it("leaves a directive inside a link label alone, rather than nesting an anchor", () => {
    const html = renderMessage(
      '[see :codex-file-citation{path="/tmp/export.zip" purpose="output"}](https://example.com)',
    );

    expect(html).not.toContain("chat-markdown-file-link");
  });
});

describe("extractCodexFileCitationPaths", () => {
  it("reads every cited path, unescaped, and ignores directives without one", () => {
    expect(
      extractCodexFileCitationPaths(
        'One :codex-file-citation{path="src/a.ts" purpose="output"}, ' +
          'two :codex-file-citation{purpose="source" path="src/b \\"quoted\\".ts"}, ' +
          'three :codex-file-citation{purpose="output"}, ' +
          'four :codex-file-citation{path="src/d.ts',
      ),
    ).toEqual(["src/a.ts", 'src/b "quoted".ts']);
  });
});
