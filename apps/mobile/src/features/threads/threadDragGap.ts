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

/** LegendList only reports measured sizes; rows outside its render window
 * take their size from the next known position, else the estimate. */
export function completeThreadDragGeometry(
  offsets: readonly (number | undefined)[],
  sizes: readonly (number | undefined)[],
  estimate: number,
): { readonly offset: number; readonly height: number }[] {
  const result: { offset: number; height: number }[] = [];
  let cursor = 0;
  offsets.forEach((known, index) => {
    const offset = known !== undefined && Number.isFinite(known) ? known : cursor;
    const size = sizes[index];
    const next = offsets[index + 1];
    const height =
      size !== undefined && Number.isFinite(size) && size > 0
        ? size
        : next !== undefined && Number.isFinite(next) && next > offset
          ? next - offset
          : estimate;
    result.push({ offset, height });
    cursor = offset + height;
  });
  return result;
}

// Height of the band that stands in for an empty Pinned or Active section.
const EMPTY_SECTION_BAND = 24;

/** Resolve the row under the finger. Hovering the source or its current slot
 * is no move, so cancelling is always one step back. An empty Pinned section
 * takes drops on the top edge of the list, and an empty Active section on
 * the bottom edge of the pins. */
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
  const hasPins = input.rows.some((candidate) => candidate.section === "pinned");
  const hasActive = input.rows.some((candidate) => candidate.section === "active");
  let destination: ThreadDropDestination;
  if (
    !hasPins &&
    row.section === "active" &&
    row === input.rows.find((candidate) => candidate.section === "active") &&
    input.contentY < row.offset + EMPTY_SECTION_BAND
  ) {
    destination = { section: "pinned", targetId: null, placement: "before" };
  } else if (
    !hasActive &&
    row.section === "pinned" &&
    row === input.rows.findLast((candidate) => candidate.section === "pinned") &&
    input.contentY >= row.offset + row.height - EMPTY_SECTION_BAND
  ) {
    destination = { section: "active", targetId: null, placement: "before" };
  } else if (row.section === "settled") {
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
  if (destination === null || destination.section === "settled") return sourceOffset;
  if (destination.targetId === null) {
    // Empty sections open at the boundary between the pins and Active.
    const live = rows.filter((row) => row.section === "pinned" || row.section === "active");
    const edge = destination.section === "pinned" ? live[0] : live.at(-1);
    if (edge === undefined) return sourceOffset;
    return destination.section === "pinned" ? edge.offset : edge.offset + edge.height;
  }
  const target = rows.find((row) => row.threadKey === destination.targetId);
  if (target === undefined) return sourceOffset;
  return target.offset + (destination.placement === "after" ? target.height : 0);
}
