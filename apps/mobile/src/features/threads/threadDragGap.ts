import type { ThreadDragSection, ThreadMoveDestination } from "./threadOrder";

/** Keep hit testing in the original layout while rows make room for the lifted item. */
export function threadDragGapOffset(
  rowOffset: number,
  sourceOffset: number,
  sourceHeight: number,
  insertionOffset: number,
): number {
  "worklet";
  if (rowOffset === sourceOffset) return 0;
  if (insertionOffset <= sourceOffset) {
    return rowOffset >= insertionOffset && rowOffset < sourceOffset ? sourceHeight : 0;
  }
  return rowOffset > sourceOffset && rowOffset < insertionOffset ? -sourceHeight : 0;
}

export type ThreadDropDestination = Exclude<ThreadMoveDestination, string>;

/** A list row as laid out when the drag began. `section` is null for rows
 * that take no drops, such as queued tasks and shelf headers. */
export interface ThreadDragRow {
  readonly key: string;
  readonly threadKey: string | null;
  readonly section: ThreadDragSection | null;
  readonly offset: number;
  readonly height: number;
}

/** Resolve the row under the finger. Hovering the source or its current slot
 * is no move, so cancelling is always one step back. */
export function resolveThreadDrop(input: {
  readonly rows: readonly ThreadDragRow[];
  readonly contentY: number;
  readonly source: { readonly threadKey: string; readonly section: ThreadDragSection };
  readonly canDrop: (destination: ThreadDropDestination) => boolean;
}): ThreadDropDestination | null {
  const row =
    input.rows.find((candidate) => input.contentY < candidate.offset + candidate.height) ??
    input.rows.at(-1);
  if (row === undefined || row.section === null || row.section === "snoozed") return null;
  let destination: ThreadDropDestination;
  if (row.section === "settled") {
    if (input.source.section === "settled") return null;
    destination = { section: "settled", targetId: null, placement: "before" };
  } else {
    if (row.threadKey === null || row.threadKey === input.source.threadKey) return null;
    destination = {
      section: row.section,
      targetId: row.threadKey,
      placement: input.contentY < row.offset + row.height / 2 ? "before" : "after",
    };
  }
  return input.canDrop(destination) ? destination : null;
}

/** Where the gap opens. Settling drops leave the list in place. */
export function threadDropInsertionOffset(
  rows: readonly ThreadDragRow[],
  destination: ThreadDropDestination | null,
  sourceOffset: number,
): number {
  if (destination === null || destination.targetId === null) return sourceOffset;
  const target = rows.find((row) => row.threadKey === destination.targetId);
  if (target === undefined) return sourceOffset;
  return target.offset + (destination.placement === "after" ? target.height : 0);
}
