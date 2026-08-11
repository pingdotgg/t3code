import { describe, expect, it, vi } from "vitest";

import { dispatchZoomMenuAction } from "./zoomMenuAction.ts";

function makeWindow() {
  return {
    isDestroyed: vi.fn(() => false),
    webContents: {
      isLoadingMainFrame: vi.fn(() => false),
      once: vi.fn(),
      send: vi.fn(),
    },
  };
}

describe("dispatchZoomMenuAction", () => {
  it("sends zoom to the existing app window without changing focus", () => {
    const appWindow = makeWindow();

    dispatchZoomMenuAction(appWindow, "menu-action", "zoom-in");

    expect(appWindow.webContents.send).toHaveBeenCalledWith("menu-action", "zoom-in");
  });

  it("does nothing when no app window exists", () => {
    expect(() => dispatchZoomMenuAction(null, "menu-action", "zoom-out")).not.toThrow();
  });
});
