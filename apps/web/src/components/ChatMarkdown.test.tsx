import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import ChatMarkdown from "./ChatMarkdown";

describe("ChatMarkdown", () => {
  it("renders inline code file paths as file links", () => {
    const markup = renderToStaticMarkup(
      <ChatMarkdown
        text="Update `src/components/ChatMarkdown.tsx:42`."
        cwd="/Users/julius/project"
      />,
    );

    expect(markup).toContain("chat-markdown-file-link");
    expect(markup).toContain("ChatMarkdown.tsx");
    expect(markup).toContain("L42");
  });

  it("leaves fenced code blocks and inline code in link labels unchanged", () => {
    const markup = renderToStaticMarkup(
      <ChatMarkdown
        text={"[Open `src/main.ts:1`](https://example.com)\n\n```\nsrc/main.ts:1\n```"}
        cwd="/Users/julius/project"
      />,
    );

    expect(markup).not.toContain("chat-markdown-file-link");
    expect(markup).toContain("chat-markdown-codeblock");
    expect(markup).toContain("<code>src/main.ts:1</code>");
  });

  it("disambiguates only rendered inline file links", () => {
    const markup = renderToStaticMarkup(
      <ChatMarkdown
        text={"[Open `src/a/foo.ts`](https://example.com) and `src/b/foo.ts`."}
        cwd="/Users/julius/project"
      />,
    );

    expect(markup.match(/href="\/Users\/julius\/project\/src\/b\/foo\.ts"/g)).toHaveLength(1);
    expect(markup).not.toContain("foo.ts · src/a");
    expect(markup).not.toContain("foo.ts · src/b");
  });
});
