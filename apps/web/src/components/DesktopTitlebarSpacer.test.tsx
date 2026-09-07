import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { DesktopTitlebarSpacer } from "./DesktopTitlebarSpacer";

describe("DesktopTitlebarSpacer", () => {
  it("renders a full workspace drag region in Electron", () => {
    const markup = renderToStaticMarkup(<DesktopTitlebarSpacer enabled />);

    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain("workspace-topbar");
    expect(markup).toContain("drag-region");
  });

  it("does not reserve titlebar space in the browser", () => {
    expect(renderToStaticMarkup(<DesktopTitlebarSpacer enabled={false} />)).toBe("");
  });
});
