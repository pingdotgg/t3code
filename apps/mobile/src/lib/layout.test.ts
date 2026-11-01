import { describe, expect, it } from "vite-plus/test";

import {
  alignListPaneToHinge,
  deriveLayout,
  deriveThreadFeedInitialContentInset,
  deriveThreadArrangementSizing,
  deriveThreadWorkLogSizing,
  deriveWorkspacePaneLayout,
  isPrimarySidebarPinned,
} from "./layout";

describe("thread arrangement text sizing", () => {
  it("fits two title lines and section labels with combined app and system text scaling", () => {
    const sizing = deriveThreadArrangementSizing({ baseFontSize: 22, fontScale: 1.3 });
    expect(sizing.rowHeight).toBeGreaterThanOrEqual(2 * 32 * 1.3 + 10);
    expect(sizing.headerHeight).toBeGreaterThanOrEqual(26 * 1.3 + 24);
    expect(deriveThreadArrangementSizing({ baseFontSize: 16, fontScale: 1 })).toEqual({
      rowHeight: 56,
      headerHeight: 48,
    });
  });
});

describe("thread work-log text sizing", () => {
  it.each([
    { baseFontSize: 16, fontScale: 1.25, estimatedRowHeight: 28 },
    { baseFontSize: 22, fontScale: 2, estimatedRowHeight: 52 },
  ])(
    "measures accessibility text instead of locking it to the estimate: %j",
    ({ estimatedRowHeight, ...settings }) => {
      expect(deriveThreadWorkLogSizing(settings)).toMatchObject({
        estimatedRowHeight,
        fixedRowHeight: undefined,
      });
    },
  );

  it("invalidates native text measurements even when the minimum row height is unchanged", () => {
    const original = deriveThreadWorkLogSizing({ baseFontSize: 16, fontScale: 1 });
    for (const settings of [
      { baseFontSize: 16, fontScale: 1.1 },
      { baseFontSize: 17, fontScale: 1 },
    ]) {
      const resized = deriveThreadWorkLogSizing(settings);
      expect(resized.estimatedRowHeight).toBe(original.estimatedRowHeight);
      expect(resized.textSizeKey).not.toBe(original.textSizeKey);
    }
  });
});

describe("deriveThreadFeedInitialContentInset", () => {
  // regression: #5585 land the first thread open above the composer on Android
  it("does not double native iOS insets", () => {
    expect(
      deriveThreadFeedInitialContentInset({
        platform: "ios",
        usesNativeAutomaticInsets: true,
        bottomContentInset: 174,
      }),
    ).toBeUndefined();
  });
});

describe("native workspace sizing", () => {
  it.each([
    { width: 669, height: 951, hasHinge: true, nativeWorkspace: true, overlay: true },
    { width: 951, height: 669, hasHinge: true, nativeWorkspace: true, overlay: false },
    { width: 669, height: 951, hasHinge: false, nativeWorkspace: true, overlay: false },
    { width: 669, height: 951, hasHinge: true, nativeWorkspace: false, overlay: false },
  ])(
    "overlays only a native unfolded portrait Duo sidebar: %j",
    ({ overlay, nativeWorkspace, ...size }) => {
      const nativeMetrics = {
        ...size,
        horizontalSizeClass: "regular" as const,
        verticalBarEdge: "none" as const,
        safeArea: { top: 24, bottom: 20, left: 0, right: 0 },
        reservedRegions: [],
      };
      const layout = deriveLayout({ ...size, nativeMetrics, nativeWorkspace });
      expect(layout.primarySidebarOverlaysContent).toBe(overlay);
      for (const primarySidebarPreferredVisible of [true, false]) {
        expect(
          deriveWorkspacePaneLayout({
            layout,
            viewportWidth: size.width,
            primarySidebarPreferredVisible,
            auxiliaryPanePreferredVisible: false,
          }).contentPaneWidth,
        ).toBe(
          !overlay && primarySidebarPreferredVisible
            ? size.width - (layout.listPaneWidth ?? 0)
            : size.width,
        );
      }
    },
  );

  it("keeps the detail mounted in a narrow iPad window while UIKit still has two columns", () => {
    const nativeMetrics = {
      width: 715,
      height: 1013.5,
      hasHinge: false,
      horizontalSizeClass: "regular" as const,
      verticalBarEdge: "none" as const,
      safeArea: { top: 32, bottom: 20, left: 0, right: 0 },
      reservedRegions: [],
    };
    expect(deriveLayout({ ...nativeMetrics, nativeMetrics, nativeWorkspace: true })).toMatchObject({
      usesSplitView: true,
      listPaneWidth: 280,
    });
  });

  it.each([
    { width: 600, horizontalSizeClass: "regular" as const, split: true },
    { width: 599, horizontalSizeClass: "regular" as const, split: false },
    { width: 715, horizontalSizeClass: "compact" as const, split: false },
  ])("respects UIKit collapse and native column minimums: %j", ({ split, ...size }) => {
    const nativeMetrics = {
      ...size,
      height: 800,
      verticalBarEdge: "none" as const,
      safeArea: { top: 32, bottom: 20, left: 0, right: 0 },
      reservedRegions: [],
    };
    expect(
      deriveLayout({ ...nativeMetrics, nativeMetrics, nativeWorkspace: true }).usesSplitView,
    ).toBe(split);
  });
});

describe("isPrimarySidebarPinned", () => {
  // regression: #20406 sidebar toggle works on iPad and iPhone Duo
  it("keeps compact native roots pinned so search cannot hide the sidebar for a later split", () => {
    expect(
      isPrimarySidebarPinned({ pathname: "/", nativeWorkspace: true, usesSplitView: false }),
    ).toBe(true);
  });
});

describe("deriveWorkspacePaneLayout", () => {
  it("lets UIKit keep the sidebar independent of the inspector in landscape", () => {
    const layout = deriveLayout({ width: 1_194, height: 834 });
    for (const primarySidebarPreferredVisible of [true, false]) {
      expect(
        deriveWorkspacePaneLayout({
          layout,
          viewportWidth: 1_194,
          nativeWorkspace: true,
          primarySidebarPreferredVisible,
          auxiliaryPanePreferredVisible: true,
          auxiliaryPaneRole: "inspector",
        }),
      ).toMatchObject({
        primarySidebarVisible: primarySidebarPreferredVisible,
        primarySidebarSuppressedByAuxiliary: false,
        auxiliaryPaneVisible: true,
      });
    }
  });

  it("keeps an explicitly hidden thread sidebar hidden when the file inspector is visible", () => {
    const layout = deriveLayout({ width: 1_024, height: 1_366 });

    expect(
      deriveWorkspacePaneLayout({
        layout,
        viewportWidth: 1_024,
        primarySidebarPreferredVisible: false,
        auxiliaryPanePreferredVisible: true,
        auxiliaryPaneRole: "inspector",
      }),
    ).toMatchObject({
      primarySidebarVisible: false,
      primarySidebarSuppressedByAuxiliary: false,
      auxiliaryPaneVisible: true,
    });
  });
});

describe("alignListPaneToHinge", () => {
  const layout = deriveLayout({ width: 852, height: 880 });

  it("keeps the default split when either side of the hinge would be too narrow", () => {
    const narrowList = {
      layout,
      hinge: { x: 300, width: 0 },
      viewportWidth: 852,
      leadingWidth: 96,
    };
    const narrowDetail = {
      layout,
      hinge: { x: 600, width: 0 },
      viewportWidth: 852,
      leadingWidth: 0,
    };
    expect(alignListPaneToHinge(narrowList)).toBe(layout);
    expect(alignListPaneToHinge(narrowDetail)).toBe(layout);
  });
});
