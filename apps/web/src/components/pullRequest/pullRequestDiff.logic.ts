import type { FileDiffMetadata } from "@pierre/diffs";
import type { PullRequestDiffSide } from "@t3tools/contracts";

export interface ReviewDiffSliceState<Slice> {
  readonly key: string;
  readonly cursor: string | null;
  readonly slices: ReadonlyArray<Slice>;
}

export function retainReviewDiffSlices<Slice>(
  previous: ReviewDiffSliceState<Slice>,
  scopeKey: string,
): ReviewDiffSliceState<Slice> {
  if (previous.key !== scopeKey) return { key: scopeKey, cursor: null, slices: [] };
  return previous.cursor === null ? previous : { ...previous, cursor: null };
}

/** Only rendered hunks can anchor comments; list others off-diff. */
export function isLineInFileDiff(
  file: FileDiffMetadata,
  side: PullRequestDiffSide,
  line: number,
): boolean {
  return file.hunks.some((hunk) =>
    side === "left"
      ? line >= hunk.deletionStart && line < hunk.deletionStart + hunk.deletionCount
      : line >= hunk.additionStart && line < hunk.additionStart + hunk.additionCount,
  );
}

export function getFileViewedRange<T extends { readonly fileKey: string }>(
  files: ReadonlyArray<T>,
  fileKey: string,
  anchorFileKey: string | null,
): ReadonlyArray<T> {
  const index = files.findIndex((file) => file.fileKey === fileKey);
  if (index === -1) return [];
  const anchorIndex = files.findIndex((file) => file.fileKey === anchorFileKey);
  if (anchorIndex === -1) return files.slice(index, index + 1);
  return files.slice(Math.min(index, anchorIndex), Math.max(index, anchorIndex) + 1);
}
