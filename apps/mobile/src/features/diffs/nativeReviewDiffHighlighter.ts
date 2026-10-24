import { highlightCode, type HighlightScheme } from "../../lib/highlights";
import type { NativeReviewDiffFile } from "./nativeReviewDiffTypes";
import type { NativeReviewDiffRow, NativeReviewDiffToken } from "./nativeReviewDiffSurface";

interface NativeReviewDiffLineRow extends NativeReviewDiffRow {
  readonly kind: "line";
  readonly fileId: string;
  readonly content: string;
}

interface IndexedNativeReviewDiffLineRow {
  readonly row: NativeReviewDiffLineRow;
  readonly rowIndex: number;
}

export interface HighlightNativeReviewDiffVisibleRowsInput {
  readonly rows: ReadonlyArray<NativeReviewDiffRow>;
  readonly files: ReadonlyArray<NativeReviewDiffFile>;
  readonly scheme: HighlightScheme;
  readonly firstRowIndex: number;
  readonly lastRowIndex: number;
  readonly overscanRows?: number;
  readonly maxRows?: number;
  readonly alreadyHighlightedRowIds?: ReadonlySet<string>;
}

// Bounds each token patch the native view parses, not the highlighting itself.
const NATIVE_REVIEW_DIFF_VISIBLE_OVERSCAN_ROWS = 160;
const NATIVE_REVIEW_DIFF_VISIBLE_MAX_ROWS = 360;

function isHighlightableLineRow(row: NativeReviewDiffRow): row is NativeReviewDiffLineRow {
  return row.kind === "line" && typeof row.fileId === "string" && typeof row.content === "string";
}

function hasConsecutiveLineNumbers(
  previous: number | null | undefined,
  next: number | null | undefined,
): boolean {
  return typeof previous === "number" && typeof next === "number" && next === previous + 1;
}

function hasOnlyCommentRowsBetween(
  rows: ReadonlyArray<NativeReviewDiffRow>,
  previousRowIndex: number,
  nextRowIndex: number,
): boolean {
  for (let rowIndex = previousRowIndex + 1; rowIndex < nextRowIndex; rowIndex += 1) {
    if (rows[rowIndex]?.kind !== "comment") {
      return false;
    }
  }
  return true;
}

function canShareGrammarContext(
  previous: IndexedNativeReviewDiffLineRow,
  next: IndexedNativeReviewDiffLineRow,
  rows: ReadonlyArray<NativeReviewDiffRow>,
): boolean {
  if (
    next.row.fileId !== previous.row.fileId ||
    !hasOnlyCommentRowsBetween(rows, previous.rowIndex, next.rowIndex)
  ) {
    return false;
  }

  if (previous.row.change === "delete" || next.row.change === "delete") {
    return (
      previous.row.change !== "add" &&
      next.row.change !== "add" &&
      hasConsecutiveLineNumbers(previous.row.oldLineNumber, next.row.oldLineNumber)
    );
  }

  if (previous.row.change === "add" || next.row.change === "add") {
    return hasConsecutiveLineNumbers(previous.row.newLineNumber, next.row.newLineNumber);
  }

  return (
    previous.row.change === "context" &&
    next.row.change === "context" &&
    hasConsecutiveLineNumbers(previous.row.oldLineNumber, next.row.oldLineNumber) &&
    hasConsecutiveLineNumbers(previous.row.newLineNumber, next.row.newLineNumber)
  );
}

function clampRowIndex(index: number, rows: ReadonlyArray<NativeReviewDiffRow>) {
  if (rows.length === 0) {
    return 0;
  }

  return Math.min(rows.length - 1, Math.max(0, Math.floor(index)));
}

export function highlightNativeReviewDiffVisibleRows(
  input: HighlightNativeReviewDiffVisibleRowsInput,
): {
  readonly tokensByRowId: Record<string, ReadonlyArray<NativeReviewDiffToken>>;
  readonly rowCount: number;
} {
  const fileMap = new Map(input.files.map((file) => [file.id, file]));
  const overscanRows = input.overscanRows ?? NATIVE_REVIEW_DIFF_VISIBLE_OVERSCAN_ROWS;
  const maxRows = input.maxRows ?? NATIVE_REVIEW_DIFF_VISIBLE_MAX_ROWS;
  const startIndex = clampRowIndex(input.firstRowIndex - overscanRows, input.rows);
  const endIndex = clampRowIndex(input.lastRowIndex + overscanRows, input.rows);
  const selectedRows: IndexedNativeReviewDiffLineRow[] = [];

  for (
    let rowIndex = startIndex;
    rowIndex <= endIndex && selectedRows.length < maxRows;
    rowIndex += 1
  ) {
    const row = input.rows[rowIndex];
    if (
      row &&
      isHighlightableLineRow(row) &&
      !input.alreadyHighlightedRowIds?.has(row.id) &&
      fileMap.has(row.fileId)
    ) {
      selectedRows.push({ row, rowIndex });
    }
  }

  // Rows that continue each other's source are highlighted together so
  // multi-line constructs keep their colors.
  const tokensByRowId: Record<string, ReadonlyArray<NativeReviewDiffToken>> = {};
  let segment: IndexedNativeReviewDiffLineRow[] = [];
  const flushSegment = () => {
    const file = segment[0] ? fileMap.get(segment[0].row.fileId) : undefined;
    if (file) {
      const tokenLines = highlightCode(
        segment.map(({ row }) => row.content).join("\n"),
        file.language,
        input.scheme,
      );
      segment.forEach(({ row }, index) => {
        tokensByRowId[row.id] = tokenLines[index] ?? [];
      });
    }
    segment = [];
  };

  for (const selectedRow of selectedRows) {
    const previousRow = segment.at(-1);
    if (previousRow && !canShareGrammarContext(previousRow, selectedRow, input.rows)) {
      flushSegment();
    }
    segment.push(selectedRow);
  }
  flushSegment();

  return { tokensByRowId, rowCount: selectedRows.length };
}
