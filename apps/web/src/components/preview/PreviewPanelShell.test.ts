import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { getPreviewPanelMaxWidth, PreviewPanelShell } from "./PreviewPanelShell";

function renderPreviewPanelShell(
  mode: ComponentProps<typeof PreviewPanelShell>["mode"],
  options?: { open?: boolean; maximized?: boolean },
): string {
  const props: ComponentProps<typeof PreviewPanelShell> = {
    mode,
    ...(options?.open !== undefined ? { open: options.open } : {}),
    ...(options?.maximized !== undefined ? { maximized: options.maximized } : {}),
    children: createElement("div", null, "Panel content"),
  };
  return renderToStaticMarkup(createElement(PreviewPanelShell, props));
}

describe("getPreviewPanelMaxWidth", () => {
  it("allows the panel to use 70% of an ultra-wide viewport without a pixel ceiling", () => {
    expect(getPreviewPanelMaxWidth(6_000)).toBe(4_200);
  });

  it("rounds fractional CSS pixels down", () => {
    expect(getPreviewPanelMaxWidth(2_001)).toBe(1_400);
  });
});

describe("PreviewPanelShell", () => {
  it("isolates the inline panel surface from the animated layout gap", () => {
    const html = renderPreviewPanelShell("inline");

    expect(html).toContain("right-panel-inline-gap");
    expect(html).toContain("right-panel-inline-surface");
    expect(html).toContain("--right-panel-width:540px");
    expect(html).toContain('data-preview-panel-mode="inline"');
    expect(html).toContain('data-right-panel-open="true"');
  });

  it("exposes the closed state while the inline panel exits", () => {
    const html = renderPreviewPanelShell("inline", { open: false });

    expect(html).toContain('data-right-panel-open="false"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('inert=""');
    expect(html).toContain("right-panel-inline-surface");
  });

  it("keeps stable inline wrappers when maximized state changes", () => {
    const inlineHtml = renderPreviewPanelShell("inline");
    const maximizedHtml = renderPreviewPanelShell("inline", { maximized: true });

    for (const html of [inlineHtml, maximizedHtml]) {
      expect(html).toContain("right-panel-inline-frame");
      expect(html).toContain("right-panel-inline-body");
      expect(html).toContain("Panel content");
    }
    expect(maximizedHtml).toContain('data-preview-panel-maximized="true"');
    expect(maximizedHtml).not.toContain("right-panel-inline-gap");
    expect(maximizedHtml).toContain("right-panel-inline-surface");
    expect(maximizedHtml).not.toContain("right-panel-inline-maximized-exit");
  });

  it("keeps a maximized panel full-width while its surface exits", () => {
    const html = renderPreviewPanelShell("inline", { open: false, maximized: true });

    expect(html).toContain("right-panel-inline-maximized-exit");
    expect(html).toContain("right-panel-inline-surface");
    expect(html).toContain('data-preview-panel-maximized="true"');
    expect(html).toContain('data-right-panel-open="false"');
    expect(html).not.toContain("right-panel-inline-gap");
  });

  it("does not apply the inline opening layout to sheet panels", () => {
    const html = renderPreviewPanelShell("sheet");

    expect(html).not.toContain("right-panel-inline-gap");
    expect(html).not.toContain("right-panel-inline-surface");
  });
});
