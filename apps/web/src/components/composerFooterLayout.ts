export const COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX = 620;
export const COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX = 780;
export const COMPOSER_PRIMARY_ACTIONS_COMPACT_BREAKPOINT_PX =
  COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX;
const COMPOSER_FOOTER_CONTENT_GAP_PX = 8;
const COMPOSER_PRIMARY_ACTIONS_COMPACT_RECOVERY_PX = 120;

export function shouldUseCompactComposerFooter(
  width: number | null,
  options?: { hasWideActions?: boolean },
): boolean {
  const breakpoint = options?.hasWideActions
    ? COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX
    : COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX;
  return width !== null && width < breakpoint;
}

export function shouldUseCompactComposerPrimaryActions(
  width: number | null,
  options?: { hasWideActions?: boolean },
): boolean {
  if (!options?.hasWideActions) {
    return false;
  }
  return width !== null && width < COMPOSER_PRIMARY_ACTIONS_COMPACT_BREAKPOINT_PX;
}

export function measureComposerFooterOverflowPx(input: {
  footerContentWidth: number | null;
  leadingContentWidth: number | null;
  actionsWidth: number | null;
}): number | null {
  const footerContentWidth = input.footerContentWidth;
  const leadingContentWidth = input.leadingContentWidth;
  const actionsWidth = input.actionsWidth;
  if (footerContentWidth === null || leadingContentWidth === null || actionsWidth === null) {
    return null;
  }
  return Math.max(
    0,
    leadingContentWidth + actionsWidth + COMPOSER_FOOTER_CONTENT_GAP_PX - footerContentWidth,
  );
}

export function shouldForceCompactComposerFooterForFit(input: {
  footerContentWidth: number | null;
  leadingContentWidth: number | null;
  actionsWidth: number | null;
}): boolean {
  const overflowPx = measureComposerFooterOverflowPx(input);
  if (overflowPx === null) {
    return false;
  }
  return overflowPx > COMPOSER_PRIMARY_ACTIONS_COMPACT_RECOVERY_PX;
}

export function resolveComposerFooterContentWidth(input: {
  footerWidth: number | null;
  paddingLeft: number | null;
  paddingRight: number | null;
}): number | null {
  const footerWidth = input.footerWidth;
  const paddingLeft = input.paddingLeft;
  const paddingRight = input.paddingRight;
  if (footerWidth === null || paddingLeft === null || paddingRight === null) {
    return null;
  }
  return Math.max(0, footerWidth - paddingLeft - paddingRight);
}
