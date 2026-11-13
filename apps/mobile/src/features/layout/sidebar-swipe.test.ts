import { describe, expect, it } from "vite-plus/test";

import {
  computeEdgeExclusionBounds,
  computeSwipeScrimOpacity,
  computeSwipeSidebarWidth,
  deriveSidebarSwipeCapabilities,
  evaluateSwipeActivation,
  isInSystemEdgeExclusion,
  shouldCommitSidebarSwipe,
  SIDEBAR_FLOATING_SCRIM_OPACITY,
  SIDEBAR_SWIPE_ACTIVATION_OFFSET_X_DP,
  SIDEBAR_SWIPE_EDGE_EXCLUSION_DP,
  SIDEBAR_SWIPE_FLICK_MIN_TRAVEL_DP,
  SIDEBAR_SWIPE_FLICK_VELOCITY_X,
  SIDEBAR_SWIPE_OPPOSITE_FAIL_OFFSET_DP,
  SIDEBAR_SWIPE_VERTICAL_FAIL_OFFSET_DP,
} from "./sidebar-swipe";

const baseEligibility = {
  usesSplitView: true,
  nativeWorkspace: false,
  workspacePage: false,
  primarySidebarPinned: false,
  primarySidebarVisible: false,
  sidebarFloats: true,
  railOverlay: false,
  inspectorSheetOpen: false,
  sidebarSlotWidth: 320,
} as const;

describe("deriveSidebarSwipeCapabilities", () => {
  it("allows opening from content on medium split view when the sidebar is hidden", () => {
    expect(deriveSidebarSwipeCapabilities(baseEligibility)).toEqual({
      canOpenContent: true,
      canCloseContent: false,
      canCloseScrim: false,
    });
  });

  it("closes via scrim on medium split view when the floating sidebar is visible", () => {
    expect(
      deriveSidebarSwipeCapabilities({
        ...baseEligibility,
        primarySidebarVisible: true,
      }),
    ).toEqual({
      canOpenContent: false,
      canCloseContent: false,
      canCloseScrim: true,
    });
  });

  it("opens and closes from content on expanded split view when the sidebar is unpinned", () => {
    expect(
      deriveSidebarSwipeCapabilities({
        ...baseEligibility,
        sidebarFloats: false,
        primarySidebarVisible: false,
      }),
    ).toEqual({
      canOpenContent: true,
      canCloseContent: false,
      canCloseScrim: false,
    });

    expect(
      deriveSidebarSwipeCapabilities({
        ...baseEligibility,
        sidebarFloats: false,
        primarySidebarVisible: true,
      }),
    ).toEqual({
      canOpenContent: false,
      canCloseContent: true,
      canCloseScrim: false,
    });
  });

  it("disables all swipe gestures when split swipe is ineligible", () => {
    const disabledCases = [
      { ...baseEligibility, usesSplitView: false },
      { ...baseEligibility, nativeWorkspace: true },
      { ...baseEligibility, workspacePage: true },
      { ...baseEligibility, primarySidebarPinned: true },
      { ...baseEligibility, railOverlay: true },
      { ...baseEligibility, inspectorSheetOpen: true },
      { ...baseEligibility, sidebarSlotWidth: 0 },
    ];

    for (const input of disabledCases) {
      expect(deriveSidebarSwipeCapabilities(input)).toEqual({
        canOpenContent: false,
        canCloseContent: false,
        canCloseScrim: false,
      });
    }
  });
});

describe("system edge exclusion", () => {
  it("excludes both left and right OS navigation edge bands on unfolded foldables", () => {
    const viewportWidth = 716;
    const bounds = computeEdgeExclusionBounds(viewportWidth);
    expect(bounds).toEqual({
      left: SIDEBAR_SWIPE_EDGE_EXCLUSION_DP,
      right: viewportWidth - SIDEBAR_SWIPE_EDGE_EXCLUSION_DP,
    });

    expect(isInSystemEdgeExclusion(0, viewportWidth)).toBe(true);
    expect(isInSystemEdgeExclusion(24, viewportWidth)).toBe(true);
    expect(isInSystemEdgeExclusion(SIDEBAR_SWIPE_EDGE_EXCLUSION_DP - 0.1, viewportWidth)).toBe(
      true,
    );
    expect(isInSystemEdgeExclusion(SIDEBAR_SWIPE_EDGE_EXCLUSION_DP, viewportWidth)).toBe(false);
    expect(isInSystemEdgeExclusion(viewportWidth / 2, viewportWidth)).toBe(false);
    expect(
      isInSystemEdgeExclusion(viewportWidth - SIDEBAR_SWIPE_EDGE_EXCLUSION_DP, viewportWidth),
    ).toBe(false);
    expect(
      isInSystemEdgeExclusion(viewportWidth - SIDEBAR_SWIPE_EDGE_EXCLUSION_DP + 0.1, viewportWidth),
    ).toBe(true);
    expect(isInSystemEdgeExclusion(viewportWidth, viewportWidth)).toBe(true);
  });

  it("expands the exclusion band beyond display cutouts and safe area insets", () => {
    const bounds = computeEdgeExclusionBounds(820, 36, 40);
    expect(bounds).toEqual({ left: 60, right: 820 - 64 });
    expect(isInSystemEdgeExclusion(59, 820, 36, 40)).toBe(true);
    expect(isInSystemEdgeExclusion(60, 820, 36, 40)).toBe(false);
    expect(isInSystemEdgeExclusion(757, 820, 36, 40)).toBe(true);
    expect(isInSystemEdgeExclusion(756, 820, 36, 40)).toBe(false);
  });

  it("fails safely for degenerate viewports or non-finite coordinates", () => {
    expect(isInSystemEdgeExclusion(50, 80)).toBe(true);
    expect(isInSystemEdgeExclusion(0, 0)).toBe(true);
    expect(isInSystemEdgeExclusion(Number.NaN, 716)).toBe(true);
  });
});

describe("evaluateSwipeActivation", () => {
  it("stays pending before minimum horizontal travel", () => {
    expect(
      evaluateSwipeActivation({
        dx: SIDEBAR_SWIPE_ACTIVATION_OFFSET_X_DP - 1,
        dy: 0,
        canOpen: true,
        canClose: false,
      }),
    ).toBe("pending");
  });

  it("activates open on clean rightward horizontal drags", () => {
    expect(
      evaluateSwipeActivation({
        dx: SIDEBAR_SWIPE_ACTIVATION_OFFSET_X_DP,
        dy: 4,
        canOpen: true,
        canClose: false,
      }),
    ).toBe("activate-open");
  });

  it("activates close on clean leftward horizontal drags", () => {
    expect(
      evaluateSwipeActivation({
        dx: -SIDEBAR_SWIPE_ACTIVATION_OFFSET_X_DP,
        dy: -3,
        canOpen: false,
        canClose: true,
      }),
    ).toBe("activate-close");
  });

  it("rejects slightly diagonal vertical scrolls instead of hijacking vertical scroll", () => {
    expect(
      evaluateSwipeActivation({
        dx: SIDEBAR_SWIPE_ACTIVATION_OFFSET_X_DP,
        dy: 13,
        canOpen: true,
        canClose: false,
      }),
    ).toBe("pending");

    expect(
      evaluateSwipeActivation({
        dx: 24,
        dy: SIDEBAR_SWIPE_VERTICAL_FAIL_OFFSET_DP + 1,
        canOpen: true,
        canClose: false,
      }),
    ).toBe("fail");
  });

  it("fails quickly when dragging in an unavailable direction", () => {
    expect(
      evaluateSwipeActivation({
        dx: -(SIDEBAR_SWIPE_OPPOSITE_FAIL_OFFSET_DP + 1),
        dy: 0,
        canOpen: true,
        canClose: false,
      }),
    ).toBe("fail");

    expect(
      evaluateSwipeActivation({
        dx: SIDEBAR_SWIPE_OPPOSITE_FAIL_OFFSET_DP + 1,
        dy: 0,
        canOpen: false,
        canClose: true,
      }),
    ).toBe("fail");

    expect(
      evaluateSwipeActivation({
        dx: 0,
        dy: 0,
        canOpen: false,
        canClose: false,
      }),
    ).toBe("fail");
  });
});

describe("interactive drag metrics and commit thresholds", () => {
  it("clamps sidebar drag width and scales floating scrim opacity proportionally", () => {
    expect(computeSwipeSidebarWidth({ startWidth: 0, translationX: -20, maxWidth: 320 })).toBe(0);
    expect(computeSwipeSidebarWidth({ startWidth: 0, translationX: 160, maxWidth: 320 })).toBe(160);
    expect(computeSwipeSidebarWidth({ startWidth: 0, translationX: 400, maxWidth: 320 })).toBe(320);
    expect(computeSwipeSidebarWidth({ startWidth: 320, translationX: -120, maxWidth: 320 })).toBe(
      200,
    );

    expect(computeSwipeScrimOpacity(0, 320)).toBe(0);
    expect(computeSwipeScrimOpacity(160, 320)).toBeCloseTo(SIDEBAR_FLOATING_SCRIM_OPACITY / 2);
    expect(computeSwipeScrimOpacity(400, 320)).toBe(SIDEBAR_FLOATING_SCRIM_OPACITY);
    expect(computeSwipeScrimOpacity(100, 0)).toBe(0);
  });

  it("decides whether to commit opening based on progress and flick velocity", () => {
    expect(
      shouldCommitSidebarSwipe({
        direction: "open",
        startWidth: 0,
        currentWidth: 112,
        maxWidth: 320,
        velocityX: 0,
      }),
    ).toBe(true);

    expect(
      shouldCommitSidebarSwipe({
        direction: "open",
        startWidth: 0,
        currentWidth: 100,
        maxWidth: 320,
        velocityX: 0,
      }),
    ).toBe(false);

    expect(
      shouldCommitSidebarSwipe({
        direction: "open",
        startWidth: 0,
        currentWidth: SIDEBAR_SWIPE_FLICK_MIN_TRAVEL_DP,
        maxWidth: 320,
        velocityX: SIDEBAR_SWIPE_FLICK_VELOCITY_X,
      }),
    ).toBe(true);

    expect(
      shouldCommitSidebarSwipe({
        direction: "open",
        startWidth: 0,
        currentWidth: SIDEBAR_SWIPE_FLICK_MIN_TRAVEL_DP - 1,
        maxWidth: 320,
        velocityX: SIDEBAR_SWIPE_FLICK_VELOCITY_X + 200,
      }),
    ).toBe(false);

    expect(
      shouldCommitSidebarSwipe({
        direction: "open",
        startWidth: 0,
        currentWidth: 200,
        maxWidth: 320,
        velocityX: -SIDEBAR_SWIPE_FLICK_VELOCITY_X,
      }),
    ).toBe(false);
  });

  it("decides whether to commit closing based on progress and flick velocity", () => {
    expect(
      shouldCommitSidebarSwipe({
        direction: "close",
        startWidth: 320,
        currentWidth: 208,
        maxWidth: 320,
        velocityX: 0,
      }),
    ).toBe(false);

    expect(
      shouldCommitSidebarSwipe({
        direction: "close",
        startWidth: 320,
        currentWidth: 260,
        maxWidth: 320,
        velocityX: 0,
      }),
    ).toBe(true);

    expect(
      shouldCommitSidebarSwipe({
        direction: "close",
        startWidth: 320,
        currentWidth: 320 - SIDEBAR_SWIPE_FLICK_MIN_TRAVEL_DP,
        maxWidth: 320,
        velocityX: -SIDEBAR_SWIPE_FLICK_VELOCITY_X,
      }),
    ).toBe(false);

    expect(
      shouldCommitSidebarSwipe({
        direction: "close",
        startWidth: 320,
        currentWidth: 120,
        maxWidth: 320,
        velocityX: SIDEBAR_SWIPE_FLICK_VELOCITY_X,
      }),
    ).toBe(true);
  });
});
