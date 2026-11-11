import type { NativeReviewDiffRow } from "../../diffs/nativeReviewDiffSurface";

export type GuideDiffFocus = {
  readonly side: "old" | "new";
  readonly endSide?: "old" | "new";
  readonly start: number;
  readonly end: number;
};

export function guideFocusedRows(
  rows: readonly NativeReviewDiffRow[],
  fileId: string | undefined,
  focus: GuideDiffFocus | undefined,
) {
  if (!fileId || !focus) return [];
  if (focus.endSide && focus.endSide !== focus.side) {
    const start = rows.findIndex(
      (row) =>
        row.fileId === fileId &&
        (focus.side === "old" ? row.oldLineNumber : row.newLineNumber) === focus.start,
    );
    const end = rows.findIndex(
      (row) =>
        row.fileId === fileId &&
        (focus.endSide === "old" ? row.oldLineNumber : row.newLineNumber) === focus.end,
    );
    return start < 0 || end < 0
      ? []
      : rows
          .slice(Math.min(start, end), Math.max(start, end) + 1)
          .filter((row) => row.fileId === fileId && row.kind === "line");
  }
  return rows.filter((row) => {
    const line = focus.side === "old" ? row.oldLineNumber : row.newLineNumber;
    return (
      row.fileId === fileId &&
      row.kind === "line" &&
      line != null &&
      line >= focus.start &&
      line <= focus.end
    );
  });
}
