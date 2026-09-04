/**
 * Whether a live text selection inside the timeline should hold the composer
 * open. A drag-select in the conversation blurs the composer, and letting it
 * rest mid-gesture reflows the timeline, which dismisses the selection
 * toolbar the user was about to use.
 */
export function selectionHoldsComposerOpen(
  selection: Pick<Selection, "isCollapsed" | "rangeCount" | "getRangeAt"> | null,
  timeline: Node | null,
): boolean {
  if (!timeline || !selection || selection.isCollapsed || selection.rangeCount === 0) {
    return false;
  }
  return timeline.contains(selection.getRangeAt(0).commonAncestorContainer);
}
