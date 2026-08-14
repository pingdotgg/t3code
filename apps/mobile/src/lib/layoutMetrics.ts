/** Horizontal inset shared by the home header and compact thread list. */
export const HOME_HORIZONTAL_INSET = 20;

/** Compensates for the tighter native sidebar title margin on iPad. */
export const IPAD_HOME_TITLE_OFFSET = 10;

/**
 * Height of the native iOS navigation bar below the safe-area inset, used as
 * a fallback when the measured HeaderHeightContext is unavailable.
 */
export const IOS_NAV_BAR_HEIGHT = 44;

/* Height of the app's own header chrome below the safe-area inset, on every
 * platform (matches the `min-h-12` AndroidScreenHeader). Distinct from the
 * 44pt native iOS navigation bar.
 */
export const APP_BAR_HEIGHT = 48;
