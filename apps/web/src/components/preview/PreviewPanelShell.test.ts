import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { getPreviewPanelMaxWidth, PreviewPanelShell } from "./PreviewPanelShell";

describe("getPreviewPanelMaxWidth", () => {
  it("allows the panel to use 70% of an ultra-wide viewport without a pixel ceiling", () => {
    expect(getPreviewPanelMaxWidth(6_000)).toBe(4_200);
  });

  it("rounds fractional CSS pixels down", () => {
    expect(getPreviewPanelMaxWidth(2_001)).toBe(1_400);
  });

  it("supports an independent default width for sibling panels", () => {
    const markup = renderToStaticMarkup(
      createElement(PreviewPanelShell, {
        mode: "inline",
        widthStorageKey: "t3code:test-panel-width",
        defaultWidth: 420,
        children: "panel",
      }),
    );

    expect(markup).toContain('style="width:420px"');
  });
});
