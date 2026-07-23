import { describe, expect, it } from "vite-plus/test";

import {
  CLOSE_FOCUSED_REGION_EVENT,
  claimCloseRequestAction,
  requestCloseFocusedRegion,
  resolveCloseRequestAction,
  resolveCloseRequestTarget,
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

describe("resolveCloseRequestAction", () => {
  it("maps the resolved command to the focused region's close operation", () => {
    expect(resolveCloseRequestAction("right-panel", "rightPanel.closeActiveSurface")).toBe(
      "close-right-panel-surface",
    );
    expect(resolveCloseRequestAction("right-panel", "terminal.close")).toBeNull();
    expect(resolveCloseRequestAction("right-panel-terminal", "terminal.close")).toBe(
      "close-right-panel-terminal",
    );
    expect(resolveCloseRequestAction("right-panel-terminal", "rightPanel.closeActiveSurface")).toBe(
      "close-right-panel-surface",
    );
    expect(resolveCloseRequestAction("drawer-terminal", "terminal.close")).toBe(
      "close-drawer-terminal",
    );
    expect(
      resolveCloseRequestAction("drawer-terminal", "rightPanel.closeActiveSurface"),
    ).toBeNull();
    expect(resolveCloseRequestAction("right-panel", null)).toBeNull();
  });
});

describe("claimCloseRequestAction", () => {
  it("claims a mapped focused-region close before its operation runs", () => {
    const event = new Event("close-request", { cancelable: true });

    expect(claimCloseRequestAction(event, "right-panel", "rightPanel.closeActiveSurface")).toBe(
      "close-right-panel-surface",
    );
    expect(event.defaultPrevented).toBe(true);
  });

  it("leaves an unmapped native shortcut available for window closing", () => {
    const event = new Event("close-request", { cancelable: true });

    expect(claimCloseRequestAction(event, "right-panel", null)).toBeNull();
    expect(event.defaultPrevented).toBe(false);
  });
});
