import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { PreviewChromeRow } from "./PreviewChromeRow";

describe("PreviewChromeRow", () => {
  it("shows the complete URL while the address bar is not focused", () => {
    const markup = renderToStaticMarkup(
      <PreviewChromeRow
        url="https://example.com/dashboard?mode=edit&tab=1#notes"
        loading={false}
        canGoBack={false}
        canGoForward={false}
        refreshDisabled={false}
        onBack={vi.fn()}
        onForward={vi.fn()}
        onRefresh={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(markup).toContain('value="https://example.com/dashboard?mode=edit&amp;tab=1#notes"');
  });
});
