const STICKY_EDGE_TOLERANCE_PX = 1;

/**
 * Returns the scroll offset that puts a section's natural top where its sticky heading is now.
 * Collapsing removes the body below that heading; without this adjustment, the unchanged numeric
 * offset points into the next section and makes its sticky heading appear to replace the one the
 * reader pressed.
 */
export function sectionCollapseAnchorScrollTop(input: {
  readonly scrollTop: number;
  readonly viewportTop: number;
  readonly sectionTop: number;
  readonly headingTop: number;
}): number | null {
  const sectionHasScrolledPastViewport = input.sectionTop < input.viewportTop;
  const headingIsPinned = input.headingTop <= input.viewportTop + STICKY_EDGE_TOLERANCE_PX;
  if (!sectionHasScrolledPastViewport || !headingIsPinned) return null;

  return Math.max(0, input.scrollTop + input.sectionTop - input.viewportTop);
}
