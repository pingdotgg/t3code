import { describe, expect, it } from "vite-plus/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { getPreviewPanelMaxWidth, PreviewPanelShell } from "./PreviewPanelShell";

describe("getPreviewPanelMaxWidth", () => {
  it("allows the panel to use 70% of an ultra-wide viewport without a pixel ceiling", () => {
    expect(getPreviewPanelMaxWidth(6_000)).toBe(4_200);
  });

  it("rounds fractional CSS pixels down", () => {
    expect(getPreviewPanelMaxWidth(2_001)).toBe(1_400);
  });

  it("lets an inline maximized preview fill its parent without a resize handle", () => {
    const markup = renderToStaticMarkup(
      createElement(PreviewPanelShell, {
        mode: "inline",
        maximized: true,
        children: createElement("div", null, "Preview host"),
      }),
    );

    expect(markup).toContain("flex-1");
    expect(markup).not.toContain("w-[4px]");
    expect(markup).toContain('data-preview-panel-maximized="true"');
  });
});
