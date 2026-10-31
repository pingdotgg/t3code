import type { ReviewDiffFileStat } from "@t3tools/contracts";

export function getReviewFilePatchLookahead(
  files: ReadonlyArray<ReviewDiffFileStat>,
  startIndex: number,
  expandedFileIds: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> {
  if (startIndex < 0) return [];

  return files
    .slice(startIndex, startIndex + 3)
    .filter((file) => expandedFileIds === undefined || expandedFileIds.includes(file.path))
    .map((file) => file.path);
}
