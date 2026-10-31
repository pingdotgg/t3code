import { expect, it, vi } from "vite-plus/test";

import "~/index.css";
import {
  syncDocumentElectronPlatformClasses,
  syncDocumentWindowControlsOverlayClass,
} from "./windowControlsOverlay";

vi.mock("~/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/env")>()),
  isElectron: true,
}));

function paintedTitlebarLayout() {
  const probe = document.createElement("div");
  probe.style.cssText =
    "height: var(--workspace-topbar-height); width: var(--workspace-native-controls-inset)";
  document.body.append(probe);
  try {
    const { height, width } = probe.getBoundingClientRect();
    return { height, width };
  } finally {
    probe.remove();
  }
}

// The test page has no overlay, so env(titlebar-area-*) is undefined just as in a minimized window.
it("keeps the titlebar layout while Windows reports an empty overlay", () => {
  const overlay = Object.assign(new EventTarget(), { visible: true });
  using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
  using _overlay = vi
    .spyOn(
      navigator as unknown as { windowControlsOverlay: unknown },
      "windowControlsOverlay",
      "get",
    )
    .mockReturnValue(overlay);
  const root = document.documentElement;
  const stopPlatformClasses = syncDocumentElectronPlatformClasses("Win32");
  const stop = syncDocumentWindowControlsOverlayClass();
  try {
    overlay.visible = false;
    overlay.dispatchEvent(new Event("geometrychange"));

    expect(root.classList.contains("wco")).toBe(true);
    expect(paintedTitlebarLayout()).toEqual({ height: 40, width: 137 + 12 });
  } finally {
    stop();
    stopPlatformClasses();
    root.classList.remove("wco");
  }
});
