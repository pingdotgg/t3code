/** Horizontal inset shared by the home header and compact thread list. */
export const HOME_HORIZONTAL_INSET = 20;

/** Compensates for the tighter native sidebar title margin on iPad. */
export const IPAD_HOME_TITLE_OFFSET = 10;

/**
 * Android split-view "Threads" heading. Sized like an iOS large title, but the
 * row must clear the line box: a 34px font in a 50px row with default Android
 * `includeFontPadding` clips and smears, which desktop-window density misses
 * make unreadable.
 */
export const ANDROID_SIDEBAR_PAGE_TITLE_FONT_SIZE = 34;
export const ANDROID_SIDEBAR_PAGE_TITLE_LINE_HEIGHT = 41;
export const ANDROID_SIDEBAR_PAGE_TITLE_ROW_MIN_HEIGHT = 50;

/** Paint style for the Android split-view Threads heading. `includeFontPadding`
 * must be off: the default extra ascent clips a 34px glyph inside the 50px row. */
export function androidSidebarPageTitleTextStyle(): {
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly includeFontPadding: false;
} {
  return {
    fontSize: ANDROID_SIDEBAR_PAGE_TITLE_FONT_SIZE,
    lineHeight: ANDROID_SIDEBAR_PAGE_TITLE_LINE_HEIGHT,
    includeFontPadding: false,
  };
}

/**
 * Accessibility and layout contract for the painted Android Threads title.
 * Keep these props together so replacing the title cannot drop its TalkBack
 * heading semantics while preserving the window-density line box.
 */
export function androidSidebarPageTitleProps() {
  return {
    accessible: true as const,
    accessibilityLabel: "T3 Code, Threads" as const,
    "aria-level": 1 as const,
    role: "heading" as const,
    style: androidSidebarPageTitleTextStyle(),
  };
}

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
