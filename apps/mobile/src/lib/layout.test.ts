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
  it.each([
    {
      width: 704,
      leadingWidth: 72,
      hinge: null,
      inspectorWidth: 352,
      maximumWidth: 352,
      mainEnd: 352,
      gap: 0,
    },
    {
      width: 933,
      leadingWidth: 72,
      hinge: null,
      inspectorWidth: 466.5,
      maximumWidth: 541,
      mainEnd: 466.5,
      gap: 0,
    },
    {
      width: 744,
      leadingWidth: 72,
      hinge: null,
      inspectorWidth: 372,
      maximumWidth: 372,
      mainEnd: 372,
      gap: 0,
    },
    {
      width: 900,
      leadingWidth: 72,
      hinge: { x: 450, width: 0 },
      inspectorWidth: 450,
      maximumWidth: 508,
      mainEnd: 450,
      gap: 0,
    },
    {
      width: 744,
      leadingWidth: 72,
      hinge: { x: 372, width: 8 },
      inspectorWidth: 364,
      maximumWidth: 372,
      mainEnd: 372,
      gap: 8,
    },
    {
      width: 1000,
      leadingWidth: 72,
      hinge: null,
      inspectorWidth: 371.2,
      maximumWidth: 556.8,
      mainEnd: 628.8,
      gap: 0,
    },
  ])(
    "derives the inspector from window width and existing hinge coordinates ($width dp)",
    ({ width, leadingWidth, hinge, inspectorWidth, maximumWidth, mainEnd, gap }) => {
      const input = {
        layout: deriveLayout({ width, height: 900 }),
        viewportWidth: width - leadingWidth,
        inspectorSizing: "android" as const,
        inspectorWindow: { width, leadingWidth, hinge },
        primarySidebarPreferredVisible: true,
        auxiliaryPanePreferredVisible: true,
      };
      expect(deriveWorkspacePaneLayout(input)).toMatchObject({
        auxiliaryPaneVisible: true,
        auxiliaryPaneWidth: expect.closeTo(inspectorWidth),
        auxiliaryPaneGap: gap,
        primarySidebarVisible: input.layout.variant === "medium",
      });
      expect(width - inspectorWidth - gap).toBeCloseTo(mainEnd);
      expect(
        deriveWorkspacePaneLayout({ ...input, auxiliaryPanePreferredWidth: width }),
      ).toMatchObject({
        auxiliaryPaneWidth: expect.closeTo(maximumWidth),
        auxiliaryPaneGap: 0,
      });
      expect(
        deriveWorkspacePaneLayout({ ...input, auxiliaryPanePreferredWidth: 320 }),
      ).toMatchObject({
        auxiliaryPaneWidth: 320,
        auxiliaryPaneGap: 0,
      });
    },
  );

  it.each([
    { viewportWidth: 660, defaultWidth: 328, maximumWidth: 336 },
    { viewportWidth: 744, defaultWidth: 370, maximumWidth: 420 },
    { viewportWidth: 745, defaultWidth: 370.5, maximumWidth: 421 },
    { viewportWidth: 1100, defaultWidth: 440, maximumWidth: 660 },
  ])(
    "sizes Android panes from the available width at $viewportWidth dp",
    ({ viewportWidth, defaultWidth, maximumWidth }) => {
      const layout = deriveLayout({ width: viewportWidth + 96, height: 900 });
      for (const primarySidebarFloats of [false, true]) {
        const input = {
          layout,
          viewportWidth,
          inspectorSizing: "android" as const,
          primarySidebarFloats,
          primarySidebarPreferredVisible: true,
          auxiliaryPanePreferredVisible: true,
        };
        expect(deriveWorkspacePaneLayout(input)).toMatchObject({
          primarySidebarVisible: primarySidebarFloats,
          primarySidebarSuppressedByAuxiliary: !primarySidebarFloats,
          auxiliaryPaneVisible: true,
          auxiliaryPaneWidth: defaultWidth,
          contentPaneWidth: viewportWidth,
        });
        for (const preferredWidth of [320, 350, viewportWidth]) {
          const width = constrainAuxiliaryPaneWidth({
            preferredWidth,
            availableWidth: viewportWidth,
            inspectorSizing: "android" as const,
          });
          expect(width).toBe(Math.min(preferredWidth, maximumWidth));
          expect(
            deriveWorkspacePaneLayout({ ...input, auxiliaryPanePreferredWidth: width }),
          ).toMatchObject({
            auxiliaryPaneWidth: width,
            primarySidebarVisible: primarySidebarFloats || (viewportWidth === 1100 && width <= 400),
          });
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
      for (const nativeWorkspace of [true, false]) {
        for (const primarySidebarPreferredVisible of [true, false]) {
          expect(
            deriveWorkspacePaneLayout({
              layout,
              viewportWidth: width,
              horizontalSafeArea,
              nativeWorkspace,
              inspectorSizing: nativeWorkspace ? undefined : "android",
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
    expect(
      deriveWorkspacePaneLayout({
        layout: deriveLayout({ width: 680, height: 900 }),
        viewportWidth: 608,
        inspectorSizing: "android",
        inspectorWindow: { width: 680, leadingWidth: 72, hinge: null },
        primarySidebarPreferredVisible: false,
        auxiliaryPanePreferredVisible: true,
        auxiliaryPanePreferredWidth: 320,
      }),
    ).toMatchObject({
      primarySidebarVisible: false,
      auxiliaryPaneVisible: true,
      auxiliaryPaneWidth: 320,
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
