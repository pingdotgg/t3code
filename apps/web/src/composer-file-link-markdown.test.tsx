import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vite-plus/test";
import ChatMarkdown from "./components/ChatMarkdown";

describe("composer file link markdown", () => {
  it("keeps markdown syntax in a filename as plain link text", () => {
    const markdown = serializeComposerFileLink("/custom/*draft* &amp;");
    const markup = renderToStaticMarkup(<ReactMarkdown>{markdown}</ReactMarkdown>);

    expect(markup).toContain('href="/custom/*draft*%20%26amp;"');
    expect(markup).toContain(">*draft* &amp;amp;</a>");
    expect(markup).not.toContain("<em>");
  });

  it("renders a chip when the label carries inline formatting", () => {
    const markup = renderToStaticMarkup(
      <ChatMarkdown text="[*data*](/custom/mount/data)" cwd="/repo" />,
    );

    expect(markup).toContain("chat-markdown-file-link");
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
