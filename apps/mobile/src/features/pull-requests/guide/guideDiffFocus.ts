import type { NativeReviewDiffRow } from "../../diffs/nativeReviewDiffSurface";

export type GuideDiffFocus = {
  readonly side: "old" | "new";
  readonly start: number;
  readonly end: number;
};

export function guideFocusedRows(
  rows: readonly NativeReviewDiffRow[],
  fileId: string | undefined,
  focus: GuideDiffFocus | undefined,
) {
  if (!fileId || !focus) return [];
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
