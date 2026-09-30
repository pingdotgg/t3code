import { describe, expect, it } from "vite-plus/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PreviewPanelShell } from "./PreviewPanelShell";

describe("PreviewPanelShell", () => {
  it("lets an inline maximized preview fill its parent without a resize handle", () => {
    const markup = renderToStaticMarkup(
      createElement(PreviewPanelShell, {
        mode: "inline",
        maximized: true,
        // eslint-disable-next-line react/no-children-prop -- .ts test has no JSX children slot
        children: createElement("div", null, "Preview host"),
      }),
    );

    expect(markup).toContain("flex-1");
    expect(markup).not.toContain("w-[4px]");
    expect(markup).toContain('data-preview-panel-maximized="true"');
  });
});
