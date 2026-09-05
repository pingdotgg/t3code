import { describe, expect, it } from "vite-plus/test";

import { resolveContextStripLabelsCompact } from "./BranchToolbar.logic";
import {
  COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX,
  COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX,
  COMPOSER_RESTING_EXPANSION_MIN_PX,
  getRestingComposerImagePreviewCounts,
  resolveComposerTimelineInset,
  resolveRestingComposerControlsLayout,
  resolveRestingComposerControlsNaturalWidth,
  shouldAnimateComposerRestingTransition,
  shouldUseCompactComposerPrimaryActions,
  shouldUseCompactComposerFooter,
  shouldUseRestingComposerLayout,
} from "./composerFooterLayout";

describe("getRestingComposerImagePreviewCounts", () => {
  it("shows at most three thumbnails and counts the remainder", () => {
    expect(getRestingComposerImagePreviewCounts(0)).toEqual({
      visibleCount: 0,
      overflowCount: 0,
    });
    expect(getRestingComposerImagePreviewCounts(3)).toEqual({
      visibleCount: 3,
      overflowCount: 0,
    });
    expect(getRestingComposerImagePreviewCounts(7)).toEqual({
      visibleCount: 3,
      overflowCount: 4,
    });
  });
});

describe("shouldUseCompactComposerFooter", () => {
  it("stays expanded without a measured width", () => {
    expect(shouldUseCompactComposerFooter(null)).toBe(false);
  });

  it("switches to compact mode below the breakpoint", () => {
    expect(shouldUseCompactComposerFooter(COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX - 1)).toBe(true);
  });

  it("stays expanded at and above the breakpoint", () => {
    expect(shouldUseCompactComposerFooter(COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX)).toBe(false);
    expect(shouldUseCompactComposerFooter(COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX + 48)).toBe(false);
  });

  it("uses a higher breakpoint for wide action states", () => {
    expect(
      shouldUseCompactComposerFooter(COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX - 1, {
        hasWideActions: true,
      }),
    ).toBe(true);
    expect(
      shouldUseCompactComposerFooter(COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX, {
        hasWideActions: true,
      }),
    ).toBe(false);
  });
});

describe("shouldUseCompactComposerPrimaryActions", () => {
  it("matches the wide footer breakpoint", () => {
    expect(
      shouldUseCompactComposerPrimaryActions(
        COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX - 1,
        { hasWideActions: true },
      ),
    ).toBe(true);
    expect(
      shouldUseCompactComposerPrimaryActions(COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX, {
        hasWideActions: true,
      }),
    ).toBe(false);
  });
});

describe("resolveComposerTimelineInset", () => {
  it("follows the expanded overlay height", () => {
    expect(
      resolveComposerTimelineInset({ currentInset: 160, overlayHeight: 140, isResting: false }),
    ).toBe(140);
  });

  it("keeps a larger expanded reservation while resting", () => {
    expect(
      resolveComposerTimelineInset({ currentInset: 200, overlayHeight: 60, isResting: true }),
    ).toBe(200);
  });

  it("reserves the empty expansion when no larger height is known", () => {
    expect(
      resolveComposerTimelineInset({ currentInset: 0, overlayHeight: 60, isResting: true }),
    ).toBe(60 + COMPOSER_RESTING_EXPANSION_MIN_PX);
  });
});

describe("shouldUseRestingComposerLayout", () => {
  const resting = {
    isExistingThread: true,
    isMobileViewport: false,
    isFocused: false,
    isScrollCollapsed: false,
    hasExpandedChrome: false,
    collapseOnBlur: true,
    timelineOverflows: true,
  };

  it("uses the resting layout for an unfocused desktop composer", () => {
    expect(shouldUseRestingComposerLayout(resting)).toBe(true);
  });

  it("keeps an unfocused composer expanded when blur collapse is off", () => {
    expect(shouldUseRestingComposerLayout({ ...resting, collapseOnBlur: false })).toBe(false);
  });

  it("rests a scroll-collapsed composer even while focused", () => {
    expect(
      shouldUseRestingComposerLayout({ ...resting, isFocused: true, isScrollCollapsed: true }),
    ).toBe(true);
  });

  it("rests a scroll-collapsed composer regardless of the blur preference", () => {
    expect(
      shouldUseRestingComposerLayout({
        ...resting,
        isFocused: true,
        isScrollCollapsed: true,
        collapseOnBlur: false,
      }),
    ).toBe(true);
  });

  it("keeps the composer expanded while the timeline fits above it", () => {
    expect(shouldUseRestingComposerLayout({ ...resting, timelineOverflows: false })).toBe(false);
    expect(
      shouldUseRestingComposerLayout({
        ...resting,
        isScrollCollapsed: true,
        timelineOverflows: false,
      }),
    ).toBe(false);
  });

  it("keeps new-thread composers expanded", () => {
    expect(shouldUseRestingComposerLayout({ ...resting, isExistingThread: false })).toBe(false);
  });

  it("leaves responsive mobile on its existing collapse path", () => {
    expect(shouldUseRestingComposerLayout({ ...resting, isMobileViewport: true })).toBe(false);
  });

  it("expands when focus is anywhere in the composer", () => {
    expect(shouldUseRestingComposerLayout({ ...resting, isFocused: true })).toBe(false);
  });

  it("keeps drawers and composer-owned menus expanded", () => {
    expect(shouldUseRestingComposerLayout({ ...resting, hasExpandedChrome: true })).toBe(false);
  });
});

describe("shouldAnimateComposerRestingTransition", () => {
  it("does not animate layout measurements that settle during initial mount", () => {
    expect(
      shouldAnimateComposerRestingTransition({
        hasCompletedInitialLayout: false,
        stateChanged: true,
        hasInterruptedAnimation: false,
      }),
    ).toBe(false);
  });

  it("animates later resting-state changes and interrupted transitions", () => {
    expect(
      shouldAnimateComposerRestingTransition({
        hasCompletedInitialLayout: true,
        stateChanged: true,
        hasInterruptedAnimation: false,
      }),
    ).toBe(true);
    expect(
      shouldAnimateComposerRestingTransition({
        hasCompletedInitialLayout: true,
        stateChanged: false,
        hasInterruptedAnimation: true,
      }),
    ).toBe(true);
  });
});

describe("resolveRestingComposerControlsLayout", () => {
  // Picker 140 natural / 96 minimum, plus a 9px separator. Traits 60,
  // mode 140, overflow 24, gap 4.
  const base = {
    gap: 4,
    naturalFixedWidth: 149,
    minimumFixedWidth: 105,
    blockWidths: [60, 140],
    overflowWidth: 24,
  };

  it("shows everything when the host has room", () => {
    // 149 + 60 + 140 + 4 * 2 = 357
    expect(resolveRestingComposerControlsLayout({ ...base, hostWidth: 357 })).toEqual({
      hiddenCount: 0,
      visible: true,
    });
  });

  it("moves trailing blocks into the overflow menu until the rest fits", () => {
    // 149 + 60 + 24 + 4 * 2 = 241
    expect(resolveRestingComposerControlsLayout({ ...base, hostWidth: 356 })).toEqual({
      hiddenCount: 1,
      visible: true,
    });
    expect(resolveRestingComposerControlsLayout({ ...base, hostWidth: 241 })).toEqual({
      hiddenCount: 1,
      visible: true,
    });
    // 149 + 24 + 4 = 177
    expect(resolveRestingComposerControlsLayout({ ...base, hostWidth: 240 })).toEqual({
      hiddenCount: 2,
      visible: true,
    });
  });

  it("shrinks the picker after moving every trailing block into overflow", () => {
    expect(resolveRestingComposerControlsLayout({ ...base, hostWidth: 176 })).toEqual({
      hiddenCount: 2,
      visible: true,
    });
    // 105 + 24 + 4 = 133
    expect(resolveRestingComposerControlsLayout({ ...base, hostWidth: 133 })).toEqual({
      hiddenCount: 2,
      visible: true,
    });
  });

  it("hides the whole cluster below the picker's minimum readable width", () => {
    expect(resolveRestingComposerControlsLayout({ ...base, hostWidth: 132 })).toEqual({
      hiddenCount: 2,
      visible: false,
    });
    expect(resolveRestingComposerControlsLayout({ ...base, hostWidth: 0 })).toEqual({
      hiddenCount: 2,
      visible: false,
    });
  });

  it("uses the same thresholds while shrinking and growing", () => {
    expect(resolveRestingComposerControlsLayout({ ...base, hostWidth: 240 })).toEqual({
      hiddenCount: 2,
      visible: true,
    });
    expect(resolveRestingComposerControlsLayout({ ...base, hostWidth: 241 })).toEqual({
      hiddenCount: 1,
      visible: true,
    });
  });

  it("supports a single leading control without overflow blocks", () => {
    expect(
      resolveRestingComposerControlsLayout({
        ...base,
        naturalFixedWidth: 140,
        minimumFixedWidth: 140,
        blockWidths: [],
        overflowWidth: 0,
        hostWidth: 139,
      }),
    ).toEqual({ hiddenCount: 0, visible: false });
  });
});

describe("context strip labels and resting composer controls", () => {
  // Widths captured from a desktop renderer that crashed with React error
  // 185. The strip is 724px wide. Its expanded labels need 327px, and the
  // rest of its chrome needs 125px. The composer controls sit in the host
  // that takes whatever is left.
  const stripWidth = 724;
  const labelWidth = 327;
  const chromeWidth = 125;
  const measurement = {
    gap: 4,
    naturalFixedWidth: 96.3828125 + 5 + 4,
    minimumFixedWidth: 52 + 5 + 4,
    blockWidths: [130.6953125, 119.671875],
    overflowWidth: 28,
  };
  const naturalWidth = resolveRestingComposerControlsNaturalWidth(measurement);

  function hostWidth(compact: boolean): number {
    return stripWidth - chromeWidth - (compact ? 0 : labelWidth);
  }

  it("keeps the labels compact when the full controls only fit beside compact labels", () => {
    // Compact labels leave 599px, so the composer shows every block.
    const layout = resolveRestingComposerControlsLayout({
      ...measurement,
      hostWidth: hostWidth(true),
    });
    expect(layout).toEqual({ hiddenCount: 0, visible: true });

    // The strip reserves the natural controls width, so expanding the
    // labels is off the table: 125 + 327 + 364 > 724.
    const compact = resolveContextStripLabelsCompact({
      compact: true,
      neededWidth: chromeWidth + labelWidth + naturalWidth,
      availableWidth: stripWidth,
    });
    expect(compact).toBe(true);

    // The next pass sees the same inputs and lands on the same answer.
    expect(
      resolveRestingComposerControlsLayout({ ...measurement, hostWidth: hostWidth(compact) }),
    ).toEqual(layout);
  });

  it("does not settle when the strip only reserves the visible controls", () => {
    // Regression guard for the alternating layout. Reserving only the
    // controls left visible after two blocks moved into overflow makes the
    // strip expand its labels, which shrinks the host below what the full
    // controls need, which hides the blocks again.
    const hiddenControlsWidth = 137;
    const expands = !resolveContextStripLabelsCompact({
      compact: true,
      neededWidth: chromeWidth + labelWidth + hiddenControlsWidth,
      availableWidth: stripWidth,
    });
    expect(expands).toBe(true);
    expect(
      resolveRestingComposerControlsLayout({ ...measurement, hostWidth: hostWidth(false) }),
    ).toEqual({ hiddenCount: 2, visible: true });
  });
});

describe("resolveRestingComposerControlsLayout hysteresis", () => {
  // Same cluster as above: picker 140 natural / 96 minimum plus a 9px
  // separator, traits 60, mode 140, overflow 24, gap 4.
  const base = {
    gap: 4,
    naturalFixedWidth: 149,
    minimumFixedWidth: 105,
    blockWidths: [60, 140],
    overflowWidth: 24,
  };

  it("keeps a block in overflow when re-showing it would leave no slack", () => {
    // 149 + 60 + 140 + 4 * 2 = 357 fills the host exactly.
    expect(
      resolveRestingComposerControlsLayout({
        ...base,
        hostWidth: 357,
        previous: { hiddenCount: 1, visible: true },
      }),
    ).toEqual({ hiddenCount: 1, visible: true });
  });

  it("re-shows a block once the host clears the slack margin", () => {
    expect(
      resolveRestingComposerControlsLayout({
        ...base,
        hostWidth: 358,
        previous: { hiddenCount: 1, visible: true },
      }),
    ).toEqual({ hiddenCount: 0, visible: true });
  });

  it("restores the blocks that fit when the full cluster has no slack", () => {
    const partlyRestored = resolveRestingComposerControlsLayout({
      ...base,
      hostWidth: 357,
      previous: { hiddenCount: 2, visible: true },
    });
    expect(partlyRestored).toEqual({ hiddenCount: 1, visible: true });
    expect(
      resolveRestingComposerControlsLayout({ ...base, hostWidth: 357, previous: partlyRestored }),
    ).toEqual(partlyRestored);
    expect(
      resolveRestingComposerControlsLayout({ ...base, hostWidth: 358, previous: partlyRestored }),
    ).toEqual({ hiddenCount: 0, visible: true });
  });

  it("requires slack before partially restoring a cluster", () => {
    // One inline block, the picker, and overflow need 149 + 60 + 24 + 8 = 241px.
    const previous = { hiddenCount: 2, visible: true };
    expect(resolveRestingComposerControlsLayout({ ...base, hostWidth: 241, previous })).toEqual(
      previous,
    );
    expect(resolveRestingComposerControlsLayout({ ...base, hostWidth: 242, previous })).toEqual({
      hiddenCount: 1,
      visible: true,
    });
  });

  it("still resolves from scratch when there is no previous layout", () => {
    expect(resolveRestingComposerControlsLayout({ ...base, hostWidth: 357 })).toEqual({
      hiddenCount: 0,
      visible: true,
    });
  });

  it("settles when the measured picker width jitters below a pixel", () => {
    // Regression guard for React error #185 ("Maximum update depth
    // exceeded"). The composer re-measures on every render, so the picker's
    // recovered natural width can land a fraction of a pixel apart between
    // renders. Without hysteresis that flips hiddenCount forever.
    let layout = { hiddenCount: 0, visible: true };
    const settled: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      layout = resolveRestingComposerControlsLayout({
        ...base,
        // The picker's recovered natural width lands a half pixel apart
        // between renders.
        naturalFixedWidth: index % 2 === 0 ? 149 : 149.5,
        hostWidth: 357,
        previous: layout,
      });
      if (index >= 2) settled.push(`${layout.hiddenCount}:${layout.visible}`);
    }
    expect(new Set(settled).size).toBe(1);
  });

  it("keeps the cluster hidden until its minimum width clears the slack", () => {
    // 105 + 24 + 4 = 133 is the exact minimum for the hidden cluster.
    expect(
      resolveRestingComposerControlsLayout({
        ...base,
        hostWidth: 133,
        previous: { hiddenCount: 2, visible: false },
      }),
    ).toEqual({ hiddenCount: 2, visible: false });
    expect(
      resolveRestingComposerControlsLayout({
        ...base,
        hostWidth: 134,
        previous: { hiddenCount: 2, visible: false },
      }),
    ).toEqual({ hiddenCount: 2, visible: true });
  });
});
