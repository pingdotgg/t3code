import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../hooks/useTheme", () => ({
  useTheme: () => ({
    theme: "light",
    resolvedTheme: "light",
  }),
}));

describe("ChatMarkdown", () => {
  it("highlights assistant markdown text matches", async () => {
    const { default: ChatMarkdown } = await import("./ChatMarkdown");
    const markup = renderToStaticMarkup(
      <ChatMarkdown
        text="The **highlight** should appear inside assistant markdown."
        cwd={undefined}
        searchQuery="highlight"
        searchActive
      />,
    );

    expect(markup).toContain('data-thread-search-highlight="active"');
    expect(markup).toContain("<mark");
    expect(markup).toContain(">highlight<");
  });

  it("highlights fenced code matches without dropping the visible mark", async () => {
    const { default: ChatMarkdown } = await import("./ChatMarkdown");
    const markup = renderToStaticMarkup(
      <ChatMarkdown
        text={"```ts\nconst highlightNeedle = true;\n```"}
        cwd={undefined}
        searchQuery="highlightNeedle"
        searchActive
      />,
    );

    expect(markup).toContain('data-thread-search-highlight="active"');
    expect(markup).toContain("<mark");
    expect(markup).toContain(">highlightNeedle<");
  });
});
