import { describe, expect, it } from "vite-plus/test";

import {
  CLOSE_FOCUSED_REGION_EVENT,
  requestCloseFocusedRegion,
  resolveCloseRequestTarget,
  shouldHandleCloseRequest,
} from "./rightPanelCloseRequest";

describe("requestCloseFocusedRegion", () => {
  it("reports when the active right-panel surface handles the request", () => {
    const target = new EventTarget();
    target.addEventListener(CLOSE_FOCUSED_REGION_EVENT, (event) => {
      event.preventDefault();
    });

    expect(requestCloseFocusedRegion(target)).toBe(true);
  });

  it("leaves an unhandled request available for window closing", () => {
    expect(requestCloseFocusedRegion(new EventTarget())).toBe(false);
  });
});

describe("resolveCloseRequestTarget", () => {
  it("routes focused right-panel content through one panel close target", () => {
    expect(
      resolveCloseRequestTarget({
        focusOwner: "right-panel",
        drawerTerminalOpen: true,
        rightPanelOpen: true,
        rightPanelSurfaceKind: "diff",
      }),
    ).toBe("right-panel");
  });

  it("distinguishes a panel terminal from a drawer terminal", () => {
    expect(
      resolveCloseRequestTarget({
        focusOwner: "right-panel",
        drawerTerminalOpen: true,
        rightPanelOpen: true,
        rightPanelSurfaceKind: "terminal",
      }),
    ).toBe("right-panel-terminal");
  });

  it("keeps bottom-drawer terminal close behavior separate", () => {
    expect(
      resolveCloseRequestTarget({
        focusOwner: "drawer-terminal",
        drawerTerminalOpen: true,
        rightPanelOpen: true,
        rightPanelSurfaceKind: "terminal",
      }),
    ).toBe("drawer-terminal");
  });

  it("does not claim closed or unfocused regions", () => {
    expect(
      resolveCloseRequestTarget({
        focusOwner: "right-panel",
        drawerTerminalOpen: true,
        rightPanelOpen: false,
        rightPanelSurfaceKind: "terminal",
      }),
    ).toBeNull();
    expect(
      resolveCloseRequestTarget({
        focusOwner: "drawer-terminal",
        drawerTerminalOpen: false,
        rightPanelOpen: true,
        rightPanelSurfaceKind: "terminal",
      }),
    ).toBeNull();
    expect(
      resolveCloseRequestTarget({
        focusOwner: null,
        drawerTerminalOpen: true,
        rightPanelOpen: true,
        rightPanelSurfaceKind: "terminal",
      }),
    ).toBeNull();
  });
});

describe("shouldHandleCloseRequest", () => {
  it("honors the command resolved from the current keymap", () => {
    expect(shouldHandleCloseRequest("right-panel", "rightPanel.closeActiveSurface")).toBe(true);
    expect(shouldHandleCloseRequest("right-panel", "terminal.close")).toBe(false);
    expect(shouldHandleCloseRequest("right-panel-terminal", "terminal.close")).toBe(true);
    expect(shouldHandleCloseRequest("right-panel-terminal", "rightPanel.closeActiveSurface")).toBe(
      true,
    );
    expect(shouldHandleCloseRequest("drawer-terminal", "terminal.close")).toBe(true);
    expect(shouldHandleCloseRequest("drawer-terminal", "rightPanel.closeActiveSurface")).toBe(
      false,
    );
    expect(shouldHandleCloseRequest("right-panel", null)).toBe(false);
  });
});
