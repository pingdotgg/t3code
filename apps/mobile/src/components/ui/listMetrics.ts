/** Minimum heights of tappable rows: a header control, and a list item. */
export const ROW_MIN_HEIGHT = { control: 44, item: 44 } as const;

/** Keeps a list at a readable width. iOS sheets and columns already bound it. */
export const READABLE_WIDTH_STYLE = undefined;

/** Insets for a scroll view of grouped list sections. */
export function groupedListInsets(inInspector: boolean) {
  return { paddingHorizontal: inInspector ? 12 : 20, gap: 14 };
}
