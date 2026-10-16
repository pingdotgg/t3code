const STICKY_EDGE_TOLERANCE_PX = 1;

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
