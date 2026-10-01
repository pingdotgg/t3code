import type { ReactNode } from "react";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { jsx } from "react/jsx-runtime";
import { describe, expect, it, vi } from "vite-plus/test";

import type { PreviewPanelMode } from "./PreviewPanelShell";

// The resize hook binds window listeners; the retention behavior under test
// does not involve dragging, so pin the width and neutralize the handlers.
vi.mock("~/hooks/useResizableWidth", () => ({
  useResizableWidth: () => ({
    width: 540,
    handlers: {
      onPointerDown: () => {},
      onPointerMove: () => {},
      onPointerUp: () => {},
      onPointerCancel: () => {},
      onLostPointerCapture: () => {},
    },
  }),
}));

import { getPreviewPanelMaxWidth, PreviewPanelShell } from "./PreviewPanelShell";

describe("getPreviewPanelMaxWidth", () => {
  it("allows the panel to use 70% of an ultra-wide viewport without a pixel ceiling", () => {
    expect(getPreviewPanelMaxWidth(6_000)).toBe(4_200);
  });

  it("rounds fractional CSS pixels down", () => {
    expect(getPreviewPanelMaxWidth(2_001)).toBe(1_400);
  });

  it("reserves the sibling column minimum when the flex row is known", () => {
    // Fullscreen 14" MacBook: viewport 1512, sidebar ~256 → row of 1256.
    // The 70% fraction (1058) would leave the chat column only ~198px;
    // the container clamp caps the panel at 1256 − 360 instead.
    expect(getPreviewPanelMaxWidth(1_512, 1_256)).toBe(896);
  });

  it("keeps the fraction cap when the row is wide enough for both columns", () => {
    expect(getPreviewPanelMaxWidth(3_000, 2_900)).toBe(2_100);
  });

  it("rounds fractional row widths down", () => {
    expect(getPreviewPanelMaxWidth(1_512, 1_256.6)).toBe(896);
  });

  it("never drops below the panel minimum when the row cannot fit both columns", () => {
    // ~1000px window with an expanded sidebar → row of 700. The sibling
    // reservation (700 − 360 = 340) would undercut the panel's own 360
    // minimum and invert the resize clamp, so the floor wins.
    expect(getPreviewPanelMaxWidth(1_000, 700)).toBe(360);
  });

  it("stays at the panel minimum even when the row is narrower than the reservation", () => {
    expect(getPreviewPanelMaxWidth(1_512, 300)).toBe(360);
  });
});

// The mounts below run inside act(); declare the act environment React expects.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("PreviewPanelShell", () => {
  let renderer: ReactTestRenderer | undefined;

  function mountPanel(mode: PreviewPanelMode, open: boolean, children: ReactNode) {
    act(() => {
      renderer = create(jsx(PreviewPanelShell, { mode, open, children }));
    });
    return renderer!;
  }

  it("keeps closed inline content mounted but inert, and restores it on reopen", () => {
    const retained = jsx("button", { children: "Retained tab" });
    const panel = mountPanel("inline", false, retained);
    // Retention: closing must unmount nothing.
    expect(() => panel.root.findByProps({ children: "Retained tab" })).not.toThrow();
    // Suppression: the closed host is inert and hidden from assistive tech.
    const host = panel.root.findByProps({ "data-preview-panel-mode": "inline" });
    expect(host.props.inert).toBe(true);
    expect(host.props["aria-hidden"]).toBe(true);

    act(() => {
      renderer!.update(jsx(PreviewPanelShell, { mode: "inline", open: true, children: retained }));
    });
    expect(() => panel.root.findByProps({ inert: true })).toThrow();
    expect(() => panel.root.findByProps({ children: "Retained tab" })).not.toThrow();

    act(() => {
      renderer!.unmount();
    });
    renderer = undefined;
  });

  it("does not suppress sheet content when the sheet is closed", () => {
    const panel = mountPanel("sheet", false, jsx("button", { children: "Sheet content" }));
    const host = panel.root.findByProps({ "data-preview-panel-mode": "sheet" });
    expect(host.props.inert).toBe(false);
    expect(host.props["aria-hidden"]).toBeUndefined();
    expect(() => panel.root.findByProps({ children: "Sheet content" })).not.toThrow();

    act(() => {
      renderer!.unmount();
    });
    renderer = undefined;
  });
});
