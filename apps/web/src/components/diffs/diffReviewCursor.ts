import type {
  ExpansionDirections,
  FileDiffMetadata,
  HunkExpansionRegion,
  SelectedLineRange,
  SelectionSide,
} from "@pierre/diffs";
import { iterateOverDiff } from "@pierre/diffs/utils/iterateOverDiff";

export interface DiffRowRef {
  readonly lineNumber: number;
  readonly side: SelectionSide;
}

interface DiffCursorFile {
  readonly fileKey: string;
  // Lazy placeholders change identity key once loaded; the path keeps the cursor on the file.
  readonly filePath: string;
}

export type DiffReviewCursor =
  | ({ readonly mode: "file" } & DiffCursorFile)
  | ({ readonly mode: "line"; readonly row: DiffRowRef } & DiffCursorFile)
  | ({
      readonly mode: "select";
      readonly anchor: DiffRowRef;
      readonly head: DiffRowRef;
    } & DiffCursorFile);

export interface DiffRow extends DiffRowRef {
  readonly hunkIndex: number;
  readonly hiddenBefore: number;
  readonly hiddenAfter: number;
  readonly deletionLineNumber: number | null;
  readonly additionLineNumber: number | null;
}

export interface DiffGapExpansion {
  readonly hunkIndex: number;
  readonly direction: ExpansionDirections;
}

/** Each row the viewer draws for the file, top to bottom, with folded lines left out. */
export function visibleDiffRows(
  fileDiff: FileDiffMetadata,
  diffStyle: "unified" | "split",
  expandedHunks: ReadonlyMap<number, HunkExpansionRegion>,
): DiffRow[] {
  const rows: DiffRow[] = [];
  iterateOverDiff({
    diff: fileDiff,
    diffStyle,
    expandedHunks: new Map(expandedHunks),
    callback: ({ hunkIndex, collapsedBefore, collapsedAfter, additionLine, deletionLine }) => {
      const additionLineNumber = additionLine?.lineNumber ?? null;
      const deletionLineNumber = deletionLine?.lineNumber ?? null;
      rows.push({
        lineNumber: additionLineNumber ?? deletionLineNumber ?? 0,
        side: additionLineNumber === null ? "deletions" : "additions",
        hunkIndex,
        hiddenBefore: collapsedBefore,
        hiddenAfter: collapsedAfter,
        deletionLineNumber,
        additionLineNumber,
      });
    },
  });
  return rows;
}

function findRowIndex(rows: ReadonlyArray<DiffRow>, ref: DiffRowRef): number {
  return rows.findIndex((row) =>
    ref.side === "additions"
      ? row.additionLineNumber === ref.lineNumber
      : row.deletionLineNumber === ref.lineNumber,
  );
}

/** Moves one visible row, stopping at the first and last. A row no longer shown restarts at the top. */
export function stepRow(
  rows: ReadonlyArray<DiffRow>,
  ref: DiffRowRef,
  delta: 1 | -1,
): DiffRow | null {
  const index = findRowIndex(rows, ref);
  if (index < 0) return rows[0] ?? null;
  return rows[Math.min(rows.length - 1, Math.max(0, index + delta))] ?? null;
}

/**
 * The nearest still-hidden block on one side of the row, as the expansion that reveals the lines
 * touching the row. A gap keyed `i` sits above hunk `i`; key `hunks.length` trails the last hunk.
 */
export function nearestGapExpansion(
  fileDiff: FileDiffMetadata,
  rows: ReadonlyArray<DiffRow>,
  ref: DiffRowRef,
  toward: "above" | "below",
): DiffGapExpansion | null {
  const index = findRowIndex(rows, ref);
  if (index < 0) return null;
  if (toward === "above") {
    for (let cursor = index; cursor >= 0; cursor -= 1) {
      const row = rows[cursor];
      if (row && row.hiddenBefore > 0) return { hunkIndex: row.hunkIndex, direction: "down" };
    }
    return null;
  }
  for (let cursor = index; cursor < rows.length; cursor += 1) {
    const row = rows[cursor];
    if (!row) continue;
    if (cursor > index && row.hiddenBefore > 0)
      return { hunkIndex: row.hunkIndex, direction: "up" };
    if (row.hiddenAfter > 0) return { hunkIndex: fileDiff.hunks.length, direction: "up" };
  }
  return null;
}

// Expansion regions are clamped to their gap when read, so this reveals any gap in full,
// including the trailing gap of a partial diff whose size is unknown until it loads.
const WHOLE_GAP_LINE_COUNT = 1_000_000;

export interface DiffGapExpansionCount extends DiffGapExpansion {
  readonly lineCount: number;
}

/**
 * Shows the whole file while anything is hidden or nothing was expanded yet; otherwise folds back
 * exactly what the viewer reports as expanded.
 */
export function wholeFileExpansions(
  fileDiff: FileDiffMetadata,
  rows: ReadonlyArray<DiffRow>,
  expandedHunks: ReadonlyMap<number, HunkExpansionRegion>,
): ReadonlyArray<DiffGapExpansionCount> {
  const hasHiddenLines = rows.some((row) => row.hiddenBefore > 0 || row.hiddenAfter > 0);
  const folds = [...expandedHunks].flatMap(([hunkIndex, region]) => [
    ...(region.fromStart > 0
      ? [{ hunkIndex, direction: "up" as const, lineCount: -region.fromStart }]
      : []),
    ...(region.fromEnd > 0
      ? [{ hunkIndex, direction: "down" as const, lineCount: -region.fromEnd }]
      : []),
  ]);
  if (!hasHiddenLines && folds.length > 0) return folds;
  return Array.from({ length: fileDiff.hunks.length + 1 }, (_, hunkIndex) => ({
    hunkIndex,
    direction: "up" as const,
    lineCount: WHOLE_GAP_LINE_COUNT,
  }));
}

/** The cursor as a viewer selection, from where it started to where it is now. */
export function cursorSelectedRange(cursor: DiffReviewCursor): SelectedLineRange | null {
  if (cursor.mode === "file") return null;
  const [from, to] =
    cursor.mode === "line" ? [cursor.row, cursor.row] : [cursor.anchor, cursor.head];
  return { start: from.lineNumber, side: from.side, end: to.lineNumber, endSide: to.side };
}

/** Puts the range's lower row last, where a comment on it is drawn. */
export function topToBottomRange(
  range: SelectedLineRange,
  rows: ReadonlyArray<DiffRow>,
): SelectedLineRange {
  const start: DiffRowRef = { lineNumber: range.start, side: range.side ?? "additions" };
  const end: DiffRowRef = { lineNumber: range.end, side: range.endSide ?? start.side };
  if (findRowIndex(rows, end) >= findRowIndex(rows, start)) return range;
  return { start: end.lineNumber, side: end.side, end: start.lineNumber, endSide: start.side };
}

export function cursorFromSelectedRange(
  file: DiffCursorFile,
  range: SelectedLineRange,
): DiffReviewCursor {
  const anchor: DiffRowRef = { lineNumber: range.start, side: range.side ?? "additions" };
  const head: DiffRowRef = { lineNumber: range.end, side: range.endSide ?? anchor.side };
  if (anchor.lineNumber === head.lineNumber && anchor.side === head.side) {
    return { mode: "line", ...file, row: anchor };
  }
  return { mode: "select", ...file, anchor, head };
}

/** The neighbouring file, stopping at the ends; with no current file, the first. */
export function adjacentFileKey(
  fileKeys: ReadonlyArray<string>,
  currentKey: string | null,
  delta: 1 | -1,
): string | null {
  const index = currentKey === null ? -1 : fileKeys.indexOf(currentKey);
  if (index < 0) return fileKeys[0] ?? null;
  return fileKeys[Math.min(fileKeys.length - 1, Math.max(0, index + delta))] ?? null;
}

/** The next file not yet viewed in the given direction, wrapping around the list. */
export function adjacentUnviewedFileKey(
  fileKeys: ReadonlyArray<string>,
  currentKey: string | null,
  delta: 1 | -1,
  isViewed: (fileKey: string) => boolean,
): string | null {
  const count = fileKeys.length;
  const currentIndex = currentKey === null ? -1 : fileKeys.indexOf(currentKey);
  const start = currentIndex >= 0 ? currentIndex : delta > 0 ? -1 : count;
  for (let step = 1; step <= count; step += 1) {
    const key = fileKeys[(((start + delta * step) % count) + count) % count];
    if (key !== undefined && !isViewed(key)) return key;
  }
  return null;
}
