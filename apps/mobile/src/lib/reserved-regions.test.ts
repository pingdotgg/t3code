import { describe, expect, it } from "vite-plus/test";
import { deriveBottomControlInsets, type NativeLayoutMetrics } from "./reserved-regions";
import { deriveLayout, deriveWorkspacePaneLayout } from "./layout";

const innerDisplay: NativeLayoutMetrics = {
  width: 960,
  height: 560,
  horizontalSizeClass: "regular",
  verticalBarEdge: "right",
  safeArea: { top: 0, bottom: 20, left: 8, right: 72 },
  reservedRegions: [],
};

describe("bottom controls around reserved regions", () => {
  it("keeps the editor entirely on one side of a book fold", () => {
    const insets = deriveBottomControlInsets({
      ...innerDisplay,
      reservedRegions: [{ kind: "division", x: 456, y: 0, width: 48, height: 560 }],
    });
    expect(insets).toEqual({ left: 8, right: 504, bottom: 0 });
    expect(innerDisplay.width - insets.left - insets.right).toBeGreaterThan(320);
  });

  it("keeps controls below a horizontal fold in a hands-free pose", () => {
    expect(
      deriveBottomControlInsets({
        ...innerDisplay,
        reservedRegions: [{ kind: "division", x: 0, y: 240, width: 960, height: 40 }],
      }),
    ).toEqual({ left: 8, right: 72, bottom: 0 });
  });

  it("moves a control away from a bottom camera while leaving a top camera alone", () => {
    expect(
      deriveBottomControlInsets({
        ...innerDisplay,
        reservedRegions: [
          { kind: "occlusion", x: 8, y: 0, width: 60, height: 60 },
          { kind: "occlusion", x: 8, y: 510, width: 60, height: 50 },
        ],
      }),
    ).toEqual({ left: 68, right: 72, bottom: 0 });
  });
});

describe("Duo workspace sizing", () => {
  it("shows both columns on the unfolded inner display in portrait", () => {
    // Reported by the iOS 27.1 Duo simulator: no side bar or fold, only the hinge.
    const portrait: NativeLayoutMetrics = {
      width: 669,
      height: 951,
      hasHinge: true,
      horizontalSizeClass: "regular",
      verticalBarEdge: "none",
      safeArea: { top: 82, bottom: 34, left: 0, right: 0 },
      reservedRegions: [{ kind: "occlusion", x: 535, y: 0, width: 134, height: 82 }],
    };
    expect(deriveLayout({ ...portrait, nativeMetrics: portrait }).usesSplitView).toBe(true);
    const withoutHinge = { ...portrait, hasHinge: false };
    expect(deriveLayout({ ...withoutHinge, nativeMetrics: withoutHinge }).usesSplitView).toBe(
      false,
    );
  });

  it("aligns the panes to the book fold and accounts for the reserved gap", () => {
    const metrics = {
      ...innerDisplay,
      reservedRegions: [{ kind: "division" as const, x: 456, y: 0, width: 48, height: 560 }],
    };
    const layout = deriveLayout({ ...metrics, nativeMetrics: metrics });
    expect(layout.listPaneWidth).toBe(456);
    expect(layout.listPaneGap).toBe(48);
    const panes = deriveWorkspacePaneLayout({
      layout,
      viewportWidth: 960,
      primarySidebarPreferredVisible: true,
      auxiliaryPanePreferredVisible: false,
    });
    expect(panes.contentPaneWidth).toBe(456);
    expect(
      deriveWorkspacePaneLayout({
        layout,
        viewportWidth: 960,
        primarySidebarPreferredVisible: false,
        auxiliaryPanePreferredVisible: false,
      }).contentPaneWidth,
    ).toBe(960);
  });
});
