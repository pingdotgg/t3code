import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => () => Promise.resolve(),
}));

import ChatMarkdown from "./ChatMarkdown";

describe("ChatMarkdown", () => {
  it.each([
    `Thread bc880b45-fd48-42db-98fa-f211bae7cc0a`,
    "Created replacement thread: `bc880b45-fd48-42db-98fa-f211bae7cc0a`",
    "Thread BC880B45-FD48-42DB-98FA-F211BAE7CC0A",
  ])("renders thread references as internal links", (text) => {
    const markup = renderToStaticMarkup(
      <ChatMarkdown
        text={text}
        cwd="/Users/julius/project"
        threadRef={scopeThreadRef(
          EnvironmentId.make("environment-local"),
          ThreadId.make("current-thread"),
        )}
      />,
    );

    expect(markup).toContain("chat-markdown-thread-link");
    expect(markup).toContain('href="/environment-local/bc880b45-fd48-42db-98fa-f211bae7cc0a"');
    expect(markup).toContain("Open thread bc880b45-fd48-42db-98fa-f211bae7cc0a");
    expect(markup).not.toContain("BC880B45-FD48-42DB-98FA-F211BAE7CC0A");
  });

  it("does not link thread references without an environment context", () => {
    const markup = renderToStaticMarkup(
      <ChatMarkdown
        text="Thread bc880b45-fd48-42db-98fa-f211bae7cc0a"
        cwd="/Users/julius/project"
      />,
    );

    expect(markup).not.toContain("chat-markdown-thread-link");
  });

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
