import type { NativeReviewDiffData } from "./nativeReviewDiffAdapter";

/** An opened file keeps its lines and comment targets isolated from the comparison's other files. */
export function selectReviewFileDiff(
  data: NativeReviewDiffData,
  path: string,
): NativeReviewDiffData {
  const files = data.files.filter((file) => file.path === path);
  const ids = new Set(files.map((file) => file.id));
  const rows = data.rows.filter((row) => row.fileId && ids.has(row.fileId));
  const rowIds = new Set(rows.map((row) => row.id));
  return {
    files,
    rows,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
    commentTargetsByRowId: new Map(
      [...data.commentTargetsByRowId].filter(([id]) => rowIds.has(id)),
    ),
    rowIdByCommentLineId: new Map(
      [...data.rowIdByCommentLineId].filter(([, id]) => rowIds.has(id)),
    ),
  };
}
