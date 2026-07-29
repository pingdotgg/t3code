import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ThreadDetailLoadingState } from "./ThreadDetailLoadingState";

describe("ThreadDetailLoadingState", () => {
  it("renders shell metadata while the detail snapshot is loading", () => {
    const markup = renderToStaticMarkup(
      <ThreadDetailLoadingState projectTitle="T3 Code" threadTitle="Fix thread loading" />,
    );

    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain("Loading thread");
    expect(markup).toContain("T3 Code");
    expect(markup).toContain("Fix thread loading");
    expect(markup).toContain("chat-composer-glass-shell");
  });

  it("renders a generic shell before thread metadata is available", () => {
    const markup = renderToStaticMarkup(
      <ThreadDetailLoadingState projectTitle={null} threadTitle={null} />,
    );

    expect(markup).toContain('role="status"');
    expect(markup).not.toContain("No active thread");
    expect(markup).not.toContain("animate-");
  });
});
