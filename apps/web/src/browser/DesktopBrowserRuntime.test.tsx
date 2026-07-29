import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { DesktopBrowserRuntime } from "./DesktopBrowserRuntime";
import { ElectronBrowserHost } from "./ElectronBrowserHost";
import { PreviewAutomationHosts } from "~/components/preview/PreviewAutomationHosts";

describe("DesktopBrowserRuntime", () => {
  it("does not run any desktop host outside Electron", () => {
    expect(renderToStaticMarkup(<DesktopBrowserRuntime authenticated />)).toBe("");
    expect(renderToStaticMarkup(<ElectronBrowserHost />)).toBe("");
    expect(renderToStaticMarkup(<PreviewAutomationHosts />)).toBe("");
  });

  it("does not mount desktop hosts before authentication", () => {
    expect(renderToStaticMarkup(<DesktopBrowserRuntime authenticated={false} />)).toBe("");
  });
});
