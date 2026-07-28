import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ExpandedImageDialog } from "./ExpandedImageDialog";

describe("ExpandedImageDialog", () => {
  it("keeps the filename visible and offers a native download action", () => {
    const markup = renderToStaticMarkup(
      <ExpandedImageDialog
        preview={{
          images: [{ src: "/assets/hermes-render", name: "comparison-sheet.jpg" }],
          index: 0,
        }}
        onClose={() => {}}
      />,
    );

    expect(markup).toContain("comparison-sheet.jpg");
    expect(markup).toContain('href="/assets/hermes-render"');
    expect(markup).toContain('download="comparison-sheet.jpg"');
    expect(markup).toContain('aria-label="Download comparison-sheet.jpg"');
    expect(markup).toContain('aria-label="Close image preview"');
  });
});
