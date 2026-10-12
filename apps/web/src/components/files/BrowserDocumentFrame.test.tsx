import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { BrowserDocumentFrame } from "./BrowserDocumentFrame";

vi.mock("~/hooks/useHtmlRenderTheme", () => ({ useHtmlRenderTheme: () => null }));
vi.mock("~/lib/utils", () => ({ cn: (...values: string[]) => values.join(" ") }));

let renderer: ReactTestRenderer;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  if (renderer) await act(() => renderer.unmount());
  vi.unstubAllGlobals();
});

it("keeps the loaded HTML document when only its signed URL renews", async () => {
  await act(() => {
    renderer = create(
      <BrowserDocumentFrame
        src="/assets/token-a/review.html"
        title="Review"
        pdf={false}
        documentKey="review:1"
      />,
    );
  });
  const frame = renderer.root.findByType("iframe");
  await act(() => {
    renderer.update(
      <BrowserDocumentFrame
        src="/assets/token-b/review.html"
        title="Review"
        pdf={false}
        documentKey="review:1"
      />,
    );
  });
  expect(renderer.root.findByType("iframe") === frame).toBe(true);
  expect(frame.props.src).toBe("/assets/token-a/review.html");
  expect(frame.props.sandbox).not.toContain("allow-same-origin");

  await act(() => {
    renderer.update(
      <BrowserDocumentFrame
        src="/assets/token-c/review.html"
        title="Review"
        pdf={false}
        documentKey="review:2"
      />,
    );
  });
  expect(renderer.root.findByType("iframe") === frame).toBe(false);
  expect(renderer.root.findByType("iframe").props.src).toBe("/assets/token-c/review.html");
});

it("continues to reload URL-driven document callers", async () => {
  await act(() => {
    renderer = create(<BrowserDocumentFrame src="/first.html" title="Review" pdf={false} />);
  });
  await act(() => {
    renderer.update(<BrowserDocumentFrame src="/second.html" title="Review" pdf={false} />);
  });
  expect(renderer.root.findByType("iframe").props.src).toBe("/second.html");
});
