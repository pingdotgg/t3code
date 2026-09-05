export const COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX = 620;
export const COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX = 780;
export const RESTING_COMPOSER_IMAGE_THUMBNAIL_LIMIT = 3;

export function getRestingComposerImagePreviewCounts(imageCount: number): {
  visibleCount: number;
  overflowCount: number;
} {
  const visibleCount = Math.min(imageCount, RESTING_COMPOSER_IMAGE_THUMBNAIL_LIMIT);
  return {
    visibleCount,
    overflowCount: Math.max(0, imageCount - visibleCount),
  };
}

export function shouldUseCompactComposerFooter(
  width: number | null,
  options?: { hasWideActions?: boolean },
): boolean {
  const breakpoint = options?.hasWideActions
    ? COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX
    : COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX;
  return width !== null && width < breakpoint;
}

export function shouldUseRestingComposerLayout(input: {
  isExistingThread: boolean;
  isMobileViewport: boolean;
  isFocused: boolean;
  isScrollCollapsed: boolean;
  hasExpandedChrome: boolean;
  collapseOnBlur: boolean;
  /** Whether the timeline has more content than fits above the composer. */
  timelineOverflows: boolean;
}): boolean {
  // Passive draft content is deliberately absent here. Resting only clamps
  // the prompt row and overlays its actions; non-image attachment and context
  // rows keep their natural height above it while image previews move inline.
  // Banners and the tasks badge dock above the surface, so they are absent
  // too. Whether the context strip can host the relocated controls is
  // deliberately absent here: resting reclaims vertical space at every
  // desktop width, and where the strip is missing or too narrow the controls
  // simply return when the composer is focused.
  //
  // A scroll collapse rests the composer regardless of the blur preference:
  // the user asked for it with the gesture, and it lifts on the next
  // composer interaction. With blur collapse off, losing focus alone never
  // rests the composer.
  //
  // Resting exists to give reading space back to the timeline. A thread that
  // fits above the composer has nothing to reclaim, so it stays expanded and
  // never shows the collapsed row that a fresh thread would otherwise open on.
  const collapsed = input.isScrollCollapsed || (input.collapseOnBlur && !input.isFocused);
  return (
    input.isExistingThread &&
    !input.isMobileViewport &&
    input.timelineOverflows &&
    collapsed &&
    !input.hasExpandedChrome
  );
}

/**
 * How much taller the empty expanded composer is than its resting row on
 * desktop widths, from the layout classes in ChatComposer: the body loses
 * 8px of top padding, the prompt clamps from min-h-17.5 (70px) to 32px, and
 * the 48px footer leaves flow.
 */
export const COMPOSER_RESTING_EXPANSION_MIN_PX = 94;

/**
 * The space the timeline reserves at its end for the composer overlay.
 *
 * The overlay is measured live, but a resting composer is much shorter than
 * an expanded one. Reserving only the resting height lets a scroll to the end
 * land flush against the short composer, and the expansion that follows then
 * covers the last rows because the timeline never moves for footer growth.
 * While resting, the reservation keeps the last expanded height, or at least
 * the resting height plus the empty expansion, so expanding again changes
 * nothing above the composer. An expanded measurement is authoritative and
 * may shrink it.
 */
export function resolveComposerTimelineInset(input: {
  currentInset: number;
  overlayHeight: number;
  isResting: boolean;
}): number {
  return input.isResting
    ? Math.max(input.currentInset, input.overlayHeight + COMPOSER_RESTING_EXPANSION_MIN_PX)
    : input.overlayHeight;
}

export function shouldAnimateComposerRestingTransition(input: {
  hasCompletedInitialLayout: boolean;
  stateChanged: boolean;
  hasInterruptedAnimation: boolean;
}): boolean {
  return input.hasCompletedInitialLayout && (input.stateChanged || input.hasInterruptedAnimation);
}

export function shouldUseCompactComposerPrimaryActions(
  width: number | null,
  options?: { hasWideActions?: boolean },
): boolean {
  if (!options?.hasWideActions) {
    return false;
  }
  return width !== null && width < COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX;
}

export interface RestingComposerControlsMeasurement {
  gap: number;
  naturalFixedWidth: number;
  minimumFixedWidth: number;
  blockWidths: readonly number[];
  overflowWidth: number;
}

function restingComposerControlsWidth(
  input: RestingComposerControlsMeasurement,
  hiddenCount: number,
  fixedWidth = input.naturalFixedWidth,
): number {
  const { blockWidths, gap } = input;
  const visibleCount = blockWidths.length - hiddenCount;
  return (
    fixedWidth +
    blockWidths.slice(0, visibleCount).reduce((sum, width) => sum + width, 0) +
    (hiddenCount > 0 ? input.overflowWidth : 0) +
    gap * (visibleCount + (hiddenCount > 0 ? 1 : 0))
  );
}

/**
 * The width the resting controls take with nothing moved into overflow.
 *
 * The context strip reserves this much for the composer before deciding
 * whether its own labels may expand. Judging against the currently visible
 * controls instead lets the strip expand into space the composer just gave
 * up, which shrinks the host, hides the controls again, and repeats.
 */
export function resolveRestingComposerControlsNaturalWidth(
  input: RestingComposerControlsMeasurement,
): number {
  return restingComposerControlsWidth(input, 0);
}

/**
 * Decide how many trailing resting control blocks move into the overflow
 * menu, and whether the cluster can show at all, from natural widths.
 *
 * Trailing blocks hide before the model picker shrinks. Once they are all in
 * the overflow menu, the picker may contract to its minimum readable width;
 * below that the whole cluster hides rather than clipping.
 */
const RESTING_CONTROLS_SLACK_PX = 1;

export function resolveRestingComposerControlsLayout(
  input: RestingComposerControlsMeasurement & {
    hostWidth: number;
    previous?: { hiddenCount: number; visible: boolean };
  },
): { hiddenCount: number; visible: boolean } {
  const { blockWidths, hostWidth, previous } = input;
  let hiddenCount = 0;
  while (
    hiddenCount < blockWidths.length &&
    restingComposerControlsWidth(input, hiddenCount) > hostWidth
  ) {
    hiddenCount += 1;
  }
  // Growing the overflow menu is unconditional, or the controls would clip.
  // Shrinking it has to earn a pixel of slack first: the picker is flexible,
  // so its natural width is recovered from a truncated label whose
  // scrollWidth is integral while the rendered box is fractional. The
  // composer re-measures on every render, so without that margin a host
  // sitting exactly on a threshold flips a block in and out until React
  // gives up with "Maximum update depth exceeded".
  if (previous) {
    const previousHiddenCount = Math.min(previous.hiddenCount, blockWidths.length);
    while (
      hiddenCount < previousHiddenCount &&
      restingComposerControlsWidth(input, hiddenCount) > hostWidth - RESTING_CONTROLS_SLACK_PX
    ) {
      hiddenCount += 1;
    }
  }
  const minimumWidth = restingComposerControlsWidth(input, hiddenCount, input.minimumFixedWidth);
  const visible =
    previous && !previous.visible
      ? minimumWidth <= hostWidth - RESTING_CONTROLS_SLACK_PX
      : minimumWidth <= hostWidth;
  return { hiddenCount, visible };
}
