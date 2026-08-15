import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vite-plus/test";
import ChatMarkdown from "./components/ChatMarkdown";

const mention = (path: string, text: string) => ({
  version: 1 as const,
  environmentId: "test" as never,
  path,
  kind: "file" as const,
  start: text.indexOf(serializeComposerFileLink(path)),
  end: text.indexOf(serializeComposerFileLink(path)) + serializeComposerFileLink(path).length,
});

describe("composer file link markdown", () => {
  it("keeps markdown syntax in a filename as plain link text", () => {
    const markdown = serializeComposerFileLink("/custom/*draft* &amp;");
    const markup = renderToStaticMarkup(<ReactMarkdown>{markdown}</ReactMarkdown>);

    expect(markup).toContain('href="/custom/*draft*%20%26amp;"');
    expect(markup).toContain(">*draft* &amp;amp;</a>");
    expect(markup).not.toContain("<em>");
  });

  it("renders a chip only for an explicitly mentioned range", () => {
    const text = serializeComposerFileLink("/custom/mount/data");
    const markup = renderToStaticMarkup(
      <ChatMarkdown text={text} cwd="/repo" fileMentions={[mention("/custom/mount/data", text)]} />,
    );

    expect(markup).toContain("chat-markdown-file-link");
  });

  it("renders an explicit chip inside an over-indented list item", () => {
    const path = "/custom/mount/data";
    const source = serializeComposerFileLink(path);
    const text = `-       ${source}`;
    const markup = renderToStaticMarkup(
      <ChatMarkdown text={text} cwd="/repo" fileMentions={[mention(path, text)]} />,
    );

    expect(markup).toContain("chat-markdown-file-link");
  });

  it("does not promote an identical unmentioned link beside a normalized list item", () => {
    const path = "/custom/mount/data";
    const source = serializeComposerFileLink(path);
    const text = `${source}\n\n-       ${source}`;
    const secondStart = text.lastIndexOf(source);
    const markup = renderToStaticMarkup(
      <ChatMarkdown
        text={text}
        cwd="/repo"
        fileMentions={[
          {
            ...mention(path, text),
            start: secondStart,
            end: secondStart + source.length,
          },
        ]}
      />,
    );

    expect(markup.match(/chat-markdown-file-link/g)).toHaveLength(1);
  });

  it("preserves explicit ranges in multiline recovered list content", () => {
    const path = "/custom/mount/data";
    const source = serializeComposerFileLink(path);
    const text = `-       first block\n\n        ${source}`;
    const markup = renderToStaticMarkup(
      <ChatMarkdown text={text} cwd="/repo" fileMentions={[mention(path, text)]} />,
    );

    expect(markup).toContain("chat-markdown-file-link");
  });

  it("preserves explicit ranges through nested list recovery", () => {
    const path = "/custom/mount/data";
    const source = serializeComposerFileLink(path);
    const text = `-       first block\n\n        -       ${source}`;
    const markup = renderToStaticMarkup(
      <ChatMarkdown text={text} cwd="/repo" fileMentions={[mention(path, text)]} />,
    );

    expect(markup).toContain("chat-markdown-file-link");
  });

  it("does not promote an identical hand-authored link outside the mentioned range", () => {
    const source = serializeComposerFileLink("/custom/mount/data");
    const text = `${source} and ${source}`;
    const secondStart = text.lastIndexOf(source);
    const markup = renderToStaticMarkup(
      <ChatMarkdown
        text={text}
        cwd="/repo"
        fileMentions={[
          {
            ...mention("/custom/mount/data", text),
            start: secondStart,
            end: secondStart + source.length,
          },
        ]}
      />,
    );

    expect(markup.match(/chat-markdown-file-link/g)).toHaveLength(1);
  });

  it("matches AST offsets in UTF-16 code units", () => {
    const source = serializeComposerFileLink("/tmp/💾.txt");
    const text = `😀 ${source}`;
    const markup = renderToStaticMarkup(
      <ChatMarkdown text={text} cwd="/repo" fileMentions={[mention("/tmp/💾.txt", text)]} />,
    );

    expect(markup).toContain("chat-markdown-file-link");
  });

  it("renders explicit Windows drive paths after link sanitization", () => {
    const path = "C:\\Users\\me\\file.ts";
    const text = serializeComposerFileLink(path);
    const markup = renderToStaticMarkup(
      <ChatMarkdown text={text} cwd="C:\\repo" fileMentions={[mention(path, text)]} />,
    );

    expect(markup).toContain("chat-markdown-file-link");
    expect(markup).toContain("file.ts");
  });

  it("discovers Windows drive paths before link sanitization", () => {
    const text = serializeComposerFileLink("C:\\Users\\me\\file.ts");
    const markup = renderToStaticMarkup(<ChatMarkdown text={text} cwd="C:\\repo" />);

    expect(markup).toContain("chat-markdown-file-link");
  });

  it("ignores provenance whose range does not exactly match its canonical source", () => {
    const text = "before [data](/custom/mount/data)";
    const markup = renderToStaticMarkup(
      <ChatMarkdown
        text={text}
        cwd="/repo"
        fileMentions={[{ ...mention("/custom/mount/data", text), start: 0, end: text.length }]}
      />,
    );

    expect(markup).not.toContain("chat-markdown-file-link");
  });

  it("does not promote hand-authored route-shaped links", () => {
    const markup = renderToStaticMarkup(
      <ChatMarkdown text="[settings](/chat/settings)" cwd="/repo" fileMentions={[]} />,
    );

    expect(markup).not.toContain("chat-markdown-file-link");
    expect(markup).toContain('href="/chat/settings"');
  });

  it("handles large malformed link input without quadratic scanning", () => {
    const startedAt = performance.now();
    renderToStaticMarkup(<ChatMarkdown text={"[".repeat(64_000)} cwd="/repo" />);

    expect(performance.now() - startedAt).toBeLessThan(1_500);
  });

  it("keeps pipes in filenames inside GFM table cells", () => {
    const markdown = `| File |\n| --- |\n| ${serializeComposerFileLink("/tmp/a|b")} |`;
    const markup = renderToStaticMarkup(
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>,
    );

    expect(markup).toContain('href="/tmp/a%7Cb"');
    expect(markup).toContain(">a|b</a>");
  });
});
