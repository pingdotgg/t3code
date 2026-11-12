export function threadDragGapOffset(
  rowOffset: number,
  sourceOffset: number,
  sourceHeight: number,
  insertionOffset: number,
): number {
  if (rowOffset === sourceOffset) return 0;
  if (insertionOffset <= sourceOffset) {
    return rowOffset >= insertionOffset && rowOffset < sourceOffset ? sourceHeight : 0;
  }
  return rowOffset > sourceOffset && rowOffset < insertionOffset ? -sourceHeight : 0;
}
