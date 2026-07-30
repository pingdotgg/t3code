import { describe, expect, it } from "vite-plus/test";

import {
  constrainAuxiliaryPaneWidth,
  constrainPrimarySidebarWidth,
  deriveCenteredContentHorizontalPadding,
  deriveFileInspectorPaneLayout,
  deriveLayout,
  deriveStableFormSheetDetent,
  deriveWorkspacePaneLayout,
  SPLIT_LAYOUT_MIN_HEIGHT,
  SPLIT_LAYOUT_MIN_WIDTH,
} from "./layout";

describe("resizable pane constraints", () => {
  it("keeps a preferred sidebar width across large windows and clamps it in a narrow split view", () => {
    expect(constrainPrimarySidebarWidth(430, 1_366)).toBe(430);
    expect(constrainPrimarySidebarWidth(430, 744)).toBe(384);
    expect(constrainPrimarySidebarWidth(100, 1_366)).toBe(280);
  });

  it("preserves a useful main pane while constraining a trailing pane", () => {
    expect(constrainAuxiliaryPaneWidth({ preferredWidth: 440, availableWidth: 1_100 })).toBe(440);
    expect(constrainAuxiliaryPaneWidth({ preferredWidth: 440, availableWidth: 900 })).toBe(340);
    expect(constrainAuxiliaryPaneWidth({ preferredWidth: 100, availableWidth: 1_100 })).toBe(260);
  });
});

describe("deriveCenteredContentHorizontalPadding", () => {
  it("keeps the minimum padding while the viewport fits the reading width", () => {
    expect(
      deriveCenteredContentHorizontalPadding({
        viewportWidth: 744,
        maxContentWidth: 960,
        minimumPadding: 20,
      }),
    ).toBe(20);
  });

  it("centers only the content inside a wider full-width scroll host", () => {
    expect(
      deriveCenteredContentHorizontalPadding({
        viewportWidth: 1_032,
        maxContentWidth: 960,
        minimumPadding: 20,
      }),
    ).toBe(56);
  });

  it("supports unconstrained compact content", () => {
    expect(
      deriveCenteredContentHorizontalPadding({
        viewportWidth: 430,
        maxContentWidth: null,
        minimumPadding: 16,
      }),
    ).toBe(16);
  });
});

describe("deriveLayout", () => {
  it.each([
    { name: "small iPhone portrait", width: 375, height: 667 },
    { name: "large iPhone portrait", width: 430, height: 932 },
    { name: "small iPhone landscape", width: 667, height: 375 },
    { name: "large iPhone landscape", width: 932, height: 430 },
    { name: "short wide window", width: 1_024, height: 599 },
    { name: "narrow tall window", width: 719, height: 1_024 },
  ])("keeps a $name in the compact shell", ({ width, height }) => {
    expect(deriveLayout({ width, height })).toEqual({
      variant: "compact",
      usesSplitView: false,
      listPaneWidth: null,
      shellPadding: 0,
    });
  });

  it.each([
    { name: "small tablet portrait", width: 744, height: 1_133 },
    { name: "tablet landscape", width: 1_024, height: 768 },
    { name: "large resizable window", width: 1_366, height: 1_024 },
    { name: "foldable-sized window", width: 800, height: 700 },
  ])("uses the split shell for a $name", ({ width, height }) => {
    expect(deriveLayout({ width, height })).toMatchObject({
      variant: "split",
      usesSplitView: true,
    });
  });

  it("switches only after both space requirements are met", () => {
    expect(
      deriveLayout({ width: SPLIT_LAYOUT_MIN_WIDTH, height: SPLIT_LAYOUT_MIN_HEIGHT }).variant,
    ).toBe("split");
    expect(
      deriveLayout({ width: SPLIT_LAYOUT_MIN_WIDTH - 1, height: SPLIT_LAYOUT_MIN_HEIGHT }).variant,
    ).toBe("compact");
    expect(
      deriveLayout({ width: SPLIT_LAYOUT_MIN_WIDTH, height: SPLIT_LAYOUT_MIN_HEIGHT - 1 }).variant,
    ).toBe("compact");
  });

  it("keeps the sidebar within usable native-column bounds", () => {
    expect(deriveLayout({ width: 720, height: 1_000 }).listPaneWidth).toBe(280);
    expect(deriveLayout({ width: 1_024, height: 768 }).listPaneWidth).toBe(328);
    expect(deriveLayout({ width: 1_600, height: 1_000 }).listPaneWidth).toBe(380);
  });
});

describe("deriveWorkspacePaneLayout", () => {
  it("keeps the auxiliary pane out of a standard iPad detail column", () => {
    const layout = deriveLayout({ width: 1_194, height: 834 });

    expect(
      deriveWorkspacePaneLayout({
        layout,
        viewportWidth: 1_194,
        primarySidebarPreferredVisible: true,
        auxiliaryPanePreferredVisible: true,
      }),
    ).toEqual({
      primarySidebarVisible: true,
      primarySidebarSuppressedByAuxiliary: false,
      contentPaneWidth: 814,
      supportsAuxiliaryPane: false,
      auxiliaryPaneVisible: false,
      auxiliaryPaneWidth: null,
    });
  });

  it("offers an auxiliary pane when maximizing a standard iPad landscape window", () => {
    const layout = deriveLayout({ width: 1_194, height: 834 });

    expect(
      deriveWorkspacePaneLayout({
        layout,
        viewportWidth: 1_194,
        primarySidebarPreferredVisible: false,
        auxiliaryPanePreferredVisible: true,
      }),
    ).toEqual({
      primarySidebarVisible: false,
      primarySidebarSuppressedByAuxiliary: false,
      contentPaneWidth: 1_194,
      supportsAuxiliaryPane: true,
      auxiliaryPaneVisible: true,
      auxiliaryPaneWidth: 320,
    });
  });

  it("prioritizes a trailing file inspector over the thread sidebar at medium widths", () => {
    const layout = deriveLayout({ width: 1_024, height: 1_366 });

    expect(
      deriveWorkspacePaneLayout({
        layout,
        viewportWidth: 1_024,
        primarySidebarPreferredVisible: true,
        auxiliaryPanePreferredVisible: true,
        auxiliaryPaneRole: "inspector",
      }),
    ).toEqual({
      primarySidebarVisible: false,
      primarySidebarSuppressedByAuxiliary: true,
      contentPaneWidth: 1_024,
      supportsAuxiliaryPane: true,
      auxiliaryPaneVisible: true,
      auxiliaryPaneWidth: 260,
    });
  });

  it("keeps threads, content, and the file inspector visible in a large landscape window", () => {
    const layout = deriveLayout({ width: 1_366, height: 1_024 });

    expect(
      deriveWorkspacePaneLayout({
        layout,
        viewportWidth: 1_366,
        primarySidebarPreferredVisible: true,
        auxiliaryPanePreferredVisible: true,
        auxiliaryPaneRole: "inspector",
      }),
    ).toEqual({
      primarySidebarVisible: true,
      primarySidebarSuppressedByAuxiliary: false,
      contentPaneWidth: 986,
      supportsAuxiliaryPane: true,
      auxiliaryPaneVisible: true,
      auxiliaryPaneWidth: 276,
    });
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

  it("restores the thread sidebar when the file inspector is hidden", () => {
    const layout = deriveLayout({ width: 1_024, height: 1_366 });

    expect(
      deriveWorkspacePaneLayout({
        layout,
        viewportWidth: 1_024,
        primarySidebarPreferredVisible: true,
        auxiliaryPanePreferredVisible: false,
        auxiliaryPaneRole: "inspector",
      }),
    ).toMatchObject({
      primarySidebarVisible: true,
      primarySidebarSuppressedByAuxiliary: false,
      auxiliaryPaneVisible: false,
    });
  });

  it("keeps file navigation on the native stack below the inspector breakpoint", () => {
    const layout = deriveLayout({ width: 744, height: 1_133 });

    expect(deriveFileInspectorPaneLayout({ layout, viewportWidth: 744 })).toEqual({
      supported: false,
      width: null,
    });
    expect(
      deriveWorkspacePaneLayout({
        layout,
        viewportWidth: 744,
        primarySidebarPreferredVisible: true,
        auxiliaryPanePreferredVisible: true,
        auxiliaryPaneRole: "inspector",
      }),
    ).toMatchObject({
      primarySidebarVisible: true,
      supportsAuxiliaryPane: false,
      auxiliaryPaneVisible: false,
    });
  });

  it("supports three visible columns in a sufficiently large window", () => {
    const layout = deriveLayout({ width: 1_366, height: 1_024 });

    expect(
      deriveWorkspacePaneLayout({
        layout,
        viewportWidth: 1_366,
        primarySidebarPreferredVisible: true,
        auxiliaryPanePreferredVisible: true,
      }),
    ).toMatchObject({
      primarySidebarVisible: true,
      contentPaneWidth: 986,
      supportsAuxiliaryPane: true,
      auxiliaryPaneVisible: true,
      auxiliaryPaneWidth: 276,
    });
  });

  it("uses a preferred inspector width when all three panes still fit", () => {
    const layout = deriveLayout({ width: 1_366, height: 1_024 });

    expect(
      deriveWorkspacePaneLayout({
        layout,
        viewportWidth: 1_366,
        primarySidebarPreferredVisible: true,
        auxiliaryPanePreferredVisible: true,
        auxiliaryPaneRole: "inspector",
        auxiliaryPanePreferredWidth: 420,
      }),
    ).toMatchObject({
      primarySidebarVisible: true,
      auxiliaryPaneVisible: true,
      auxiliaryPaneWidth: 420,
    });
  });

  it("clamps a preferred supplementary width before squeezing the main pane", () => {
    const layout = deriveLayout({ width: 1_366, height: 1_024 });

    expect(
      deriveWorkspacePaneLayout({
        layout,
        viewportWidth: 1_366,
        primarySidebarPreferredVisible: true,
        auxiliaryPanePreferredVisible: true,
        auxiliaryPanePreferredWidth: 460,
      }).auxiliaryPaneWidth,
    ).toBe(426);
  });

  it("respects a hidden auxiliary-pane preference", () => {
    const layout = deriveLayout({ width: 1_366, height: 1_024 });

    expect(
      deriveWorkspacePaneLayout({
        layout,
        viewportWidth: 1_366,
        primarySidebarPreferredVisible: true,
        auxiliaryPanePreferredVisible: false,
      }).auxiliaryPaneVisible,
    ).toBe(false);
  });

  it("never exposes workspace panes in compact layouts", () => {
    const layout = deriveLayout({ width: 430, height: 932 });

    expect(
      deriveWorkspacePaneLayout({
        layout,
        viewportWidth: 430,
        primarySidebarPreferredVisible: true,
        auxiliaryPanePreferredVisible: true,
      }),
    ).toMatchObject({
      primarySidebarVisible: false,
      supportsAuxiliaryPane: false,
      auxiliaryPaneVisible: false,
      auxiliaryPaneWidth: null,
    });
  });
});

describe("deriveStableFormSheetDetent", () => {
  it.each([
    { height: 1_194, expected: 0.62 },
    { height: 834, expected: 0.863 },
    { height: 600, expected: 0.893 },
    { height: 0, expected: 0.92 },
  ])("derives a stable sheet detent for height $height", ({ height, expected }) => {
    expect(deriveStableFormSheetDetent(height)).toBe(expected);
  });
});
