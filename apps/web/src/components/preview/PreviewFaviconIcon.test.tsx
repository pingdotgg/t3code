import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ favicon: null as string | null }));

vi.mock("~/browserFaviconStore", () => ({
  useFaviconForThreadUrl: () => mocks.favicon,
}));

import { FaviconImage, PreviewFaviconIcon, selectFaviconSource } from "./PreviewFaviconIcon";

const threadRef = {
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-1"),
};

describe("preview favicon image", () => {
  it("renders a captured source before later fallback sources", () => {
    expect(
      renderToStaticMarkup(
        <FaviconImage
          sources={["data:image/png;base64,AAAA", "https://public.example/icon"]}
          fallback={<span>fallback</span>}
        />,
      ),
    ).toContain('src="data:image/png;base64,AAAA"');
    const captured = "data:image/png;base64,AAAA";
    const google = "https://public.example/icon";
    expect(selectFaviconSource([captured, google], new Set())).toBe(captured);
    expect(selectFaviconSource([captured, google], new Set([captured]))).toBe(google);
    expect(selectFaviconSource([captured, google], new Set([captured, google]))).toBeNull();
    expect(selectFaviconSource(["data:image/png;base64,BBBB", google], new Set([captured]))).toBe(
      "data:image/png;base64,BBBB",
    );
  });

  it("uses a stored project icon or falls back to the browser mockup", () => {
    mocks.favicon = null;
    const html = renderToStaticMarkup(
      <PreviewFaviconIcon threadRef={threadRef} url="http://localhost:3000/" />,
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("rounded-[5px]");
    mocks.favicon = "data:image/png;base64,AAAA";
    const faviconHtml = renderToStaticMarkup(
      <PreviewFaviconIcon threadRef={threadRef} url="http://localhost:3000/" />,
    );
    expect(faviconHtml).toContain('src="data:image/png;base64,AAAA"');
  });
});
