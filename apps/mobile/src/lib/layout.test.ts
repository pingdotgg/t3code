import { describe, expect, it } from "vite-plus/test";

import {
  alignListPaneToHinge,
  deriveLayout,
  constrainAuxiliaryPaneWidth,
  deriveThreadArrangementSizing,
  deriveThreadWorkLogSizing,
  deriveWorkspacePaneLayout,
  nativeInspectorColumnWidth,
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
  it.each([660, 745, 1100])(
    "defaults Android content to equal panes and retains resized widths at %s dp",
    (viewportWidth) => {
      const layout = deriveLayout({ width: viewportWidth + 96, height: 900 });
      for (const primarySidebarFloats of [false, true]) {
        const input = {
          layout,
          viewportWidth,
          balancedAuxiliarySplit: true,
          primarySidebarFloats,
          primarySidebarPreferredVisible: true,
          auxiliaryPanePreferredVisible: true,
        };
        expect(deriveWorkspacePaneLayout(input)).toMatchObject({
          primarySidebarVisible: false,
          primarySidebarSuppressedByAuxiliary: true,
          auxiliaryPaneVisible: true,
          auxiliaryPaneWidth: (viewportWidth - 4) / 2,
          contentPaneWidth: viewportWidth,
        });
        for (const preferredWidth of [320, 350, viewportWidth]) {
          const width = constrainAuxiliaryPaneWidth({
            preferredWidth,
            availableWidth: viewportWidth,
            balancedAuxiliarySplit: true,
          });
          expect(width).toBe(Math.min(preferredWidth, viewportWidth - 4 - 320));
          expect(
            deriveWorkspacePaneLayout({ ...input, auxiliaryPanePreferredWidth: width }),
          ).toMatchObject({ auxiliaryPaneWidth: width, primarySidebarVisible: false });
        }
        expect(
          deriveWorkspacePaneLayout({ ...input, auxiliaryPanePreferredVisible: false }),
        ).toMatchObject({ primarySidebarVisible: true });
        expect(
          deriveWorkspacePaneLayout({
            ...input,
            layout: deriveLayout({ width: 390, height: 900 }),
            viewportWidth: 390,
          }),
        ).toMatchObject({ auxiliaryPaneVisible: false });
      }
    },
  );

  it.each([
    { width: 1_194, height: 834, horizontalSafeArea: 0, fraction: 0.4, suppressed: false },
    { width: 1_032, height: 1_376, horizontalSafeArea: 0, fraction: 0.4, suppressed: true },
    // The unfolded Duo's system bar leaves no room for the sidebar beside even the narrowest inspector.
    { width: 951, height: 669, horizontalSafeArea: 76, fraction: 0, suppressed: true },
  ])(
    "steps the sidebar aside for the native inspector only when the page gets too narrow ($width wide)",
    ({ width, height, horizontalSafeArea, fraction, suppressed }) => {
      const layout = deriveLayout({ width, height });
      for (const primarySidebarPreferredVisible of [true, false]) {
        expect(
          deriveWorkspacePaneLayout({
            layout,
            viewportWidth: width,
            horizontalSafeArea,
            nativeWorkspace: true,
            primarySidebarPreferredVisible,
            auxiliaryPanePreferredVisible: true,
            nativeInspectorWidth: nativeInspectorColumnWidth({
              viewportWidth: width,
              horizontalSafeArea,
              fraction,
            }),
          }),
        ).toMatchObject({
          primarySidebarVisible: primarySidebarPreferredVisible && !suppressed,
          primarySidebarSuppressedByAuxiliary: primarySidebarPreferredVisible && suppressed,
          auxiliaryPaneVisible: true,
        });
      }
    },
  );

  it.each([
    { viewportWidth: 1_376, horizontalSafeArea: 0 },
    { viewportWidth: 951, horizontalSafeArea: 76 },
  ])(
    "never widens the native inspector past the page's minimum ($viewportWidth wide)",
    ({ viewportWidth, horizontalSafeArea }) => {
      const width = nativeInspectorColumnWidth({ viewportWidth, horizontalSafeArea, fraction: 1 });
      expect(viewportWidth - horizontalSafeArea - width).toBeGreaterThanOrEqual(320);
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
