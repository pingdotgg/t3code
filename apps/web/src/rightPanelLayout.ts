export const RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY = "(max-width: 980px)";

const RIGHT_PANEL_SHEET_BASE_CLASS_NAME =
  "p-0 wco:mt-[env(titlebar-area-height)] wco:h-[calc(100%-env(titlebar-area-height))] wco:max-h-[calc(100%-env(titlebar-area-height))]";

/**
 * Wide sheet (e.g. diff viewer) — sized for code/diff content with room for
 * long lines on tablet-sized viewports.
 */
export const RIGHT_PANEL_SHEET_CLASS_NAME = `w-[min(42vw,28rem)] min-w-80 max-w-[28rem] max-[760px]:w-[min(88vw,24rem)] max-[760px]:min-w-0 ${RIGHT_PANEL_SHEET_BASE_CLASS_NAME}`;

/**
 * Narrow sheet (e.g. plan/task sidebar) — caps at 340px to match the inline
 * sidebar width on wide viewports, preventing the sheet from covering most
 * of the content area on viewports just below the inline-layout breakpoint.
 */
export const RIGHT_PANEL_NARROW_SHEET_CLASS_NAME = `w-[min(88vw,340px)] max-w-[340px] ${RIGHT_PANEL_SHEET_BASE_CLASS_NAME}`;
