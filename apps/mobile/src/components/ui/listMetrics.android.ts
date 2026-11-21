/** Material's 48dp touch target and 56dp one-line list item. */
export const ROW_MIN_HEIGHT = { control: 48, item: 56 } as const;

/** Android sheets span the window, so a list stops at a readable width on a tablet or fold. */
export const READABLE_WIDTH_STYLE = { width: "100%", maxWidth: 720, alignSelf: "center" } as const;

/** Sections are cards with their own padding, set close in from ScreenContent's edges. */
export function groupedListInsets(_inInspector: boolean) {
  return { paddingHorizontal: 8, gap: 8 };
}
