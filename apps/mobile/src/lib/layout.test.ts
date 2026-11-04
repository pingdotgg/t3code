import { describe, expect, it } from "vite-plus/test";

import {
  ANDROID_READING_MAX_WIDTH,
  alignListPaneToHinge,
  deriveLayout,
  deriveThreadFeedInitialContentInset,
  deriveThreadArrangementSizing,
  deriveThreadWorkLogSizing,
  deriveWorkspacePaneLayout,
  nativeInspectorColumnWidth,
  isPrimarySidebarPinned,
  sidebarNarrowsAndroidReading,
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
      expect(layout.variant === "medium").toBe(overlay);
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

describe("width classes", () => {
  it.each([
    { width: 599, height: 900, variant: "compact" },
    { width: 600, height: 900, variant: "medium" },
    { width: 719, height: 900, variant: "medium" },
    { width: 720, height: 900, variant: "expanded" },
    { width: 900, height: 599, variant: "compact" },
  ] as const)("classes a window without native columns by size: %j", ({ variant, ...size }) => {
    expect(deriveLayout(size).variant).toBe(variant);
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
  it.each([
    { width: 1_194, height: 834, suppressed: false },
    { width: 1_032, height: 1_376, suppressed: true },
  ])(
    "steps the sidebar aside for the native inspector only when the page gets too narrow ($width wide)",
    ({ width, height, suppressed }) => {
      const layout = deriveLayout({ width, height });
      for (const primarySidebarPreferredVisible of [true, false]) {
        expect(
          deriveWorkspacePaneLayout({
            layout,
            viewportWidth: width,
            nativeWorkspace: true,
            primarySidebarPreferredVisible,
            auxiliaryPanePreferredVisible: true,
            nativeInspectorWidth: nativeInspectorColumnWidth(width, 0.4),
          }),
        ).toMatchObject({
          primarySidebarVisible: primarySidebarPreferredVisible && !suppressed,
          primarySidebarSuppressedByAuxiliary: primarySidebarPreferredVisible && suppressed,
          auxiliaryPaneVisible: true,
        });
      }
    },
  );

  it("keeps an explicitly hidden thread sidebar hidden when the file inspector is visible", () => {
    const layout = deriveLayout({ width: 1_024, height: 1_366 });

    expect(
      deriveWorkspacePaneLayout({
        layout,
        viewportWidth: 1_024,
        primarySidebarPreferredVisible: false,
        auxiliaryPanePreferredVisible: true,
      }),
    ).toMatchObject({
      primarySidebarVisible: false,
      primarySidebarSuppressedByAuxiliary: false,
      auxiliaryPaneVisible: true,
    });
  });
});

describe("sidebarNarrowsAndroidReading", () => {
  const RAIL = 72;
  const END_GAP = 4;
  const panesWithSidebar = (
    width: number,
    height: number,
    viewportWidth = width - RAIL,
    inspector = false,
  ) =>
    deriveWorkspacePaneLayout({
      layout: deriveLayout({ width, height }),
      viewportWidth,
      primarySidebarFloats: false,
      primarySidebarPreferredVisible: true,
      auxiliaryPanePreferredVisible: inspector,
    });

  it("keeps the sidebar beside a chat that already has its reading width", () => {
    expect(sidebarNarrowsAndroidReading(panesWithSidebar(1_280, 800), END_GAP)).toBe(false);
  });

  it("sets the sidebar aside when it keeps the chat narrower than its reading width", () => {
    expect(sidebarNarrowsAndroidReading(panesWithSidebar(900, 1_200), END_GAP)).toBe(true);
    expect(
      sidebarNarrowsAndroidReading(panesWithSidebar(1_280, 800, 1_280 - RAIL, true), END_GAP),
    ).toBe(true);
  });

  it("leaves the keyboard's old behaviour when the inspector already pushes the sidebar out", () => {
    const panes = panesWithSidebar(1_024, 768, 1_024 - RAIL, true);
    expect(panes.primarySidebarVisible).toBe(false);
    expect(sidebarNarrowsAndroidReading(panes, END_GAP)).toBe(true);
  });

  it("keeps the sidebar once the chat beside it reaches exactly the reading width", () => {
    // A 1280-wide window's sidebar is 380 wide.
    const exact = 380 + ANDROID_READING_MAX_WIDTH + END_GAP;
    expect(sidebarNarrowsAndroidReading(panesWithSidebar(1_280, 800, exact), END_GAP)).toBe(false);
    expect(sidebarNarrowsAndroidReading(panesWithSidebar(1_280, 800, exact - 1), END_GAP)).toBe(
      true,
    );
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
