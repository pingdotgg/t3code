import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ favicon: null as string | null }));

vi.mock("~/browserFaviconStore", () => ({
  useFaviconForThreadUrl: () => mocks.favicon,
}));

import { PreviewFaviconIcon } from "./PreviewFaviconIcon";

const threadRef = {
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-1"),
};

describe("PreviewFaviconIcon", () => {
  it("renders the stored favicon when one exists", () => {
    mocks.favicon = "data:image/png;base64,AAAA";
    const html = renderToStaticMarkup(
      <PreviewFaviconIcon threadRef={threadRef} url="http://localhost:3000/" />,
    );
    expect(html).toContain("data:image/png;base64,AAAA");
    expect(html).toContain("<img");
    // Non-square favicons (e.g. 32x16) must not stretch to fill the fixed
    // square box.
    expect(html).toContain("object-contain");
  });

  it("falls back to the generic browser icon when none exists", () => {
    mocks.favicon = null;
    const html = renderToStaticMarkup(
      <PreviewFaviconIcon threadRef={threadRef} url="http://localhost:3000/" />,
    );
    expect(html).not.toContain("<img");
    // BrowserMockup renders no svg; assert on a class it actually emits.
    expect(html).toContain("rounded-[5px]");
  });
});
