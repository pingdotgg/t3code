import type { FileDiffMetadata } from "@pierre/diffs";
import type {
  PullRequestDiffResult,
  PullRequestDiffSide,
  PullRequestOmittedFileStat,
} from "@t3tools/contracts";

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

export type DiffFoldOverride = "expanded" | "folded" | null;

/** Keep fold choices relative to the toolbar so later pages inherit Fold all. */
export function isFileDiffCollapsed(
  fileKey: string,
  foldOverride: DiffFoldOverride,
  toggledFileKeys: ReadonlySet<string>,
): boolean {
  const foldedByDefault = foldOverride === "folded";
  return toggledFileKeys.has(fileKey) ? !foldedByDefault : foldedByDefault;
}

export function toggleFileDiffFoldForViewed(
  fileKey: string,
  viewed: boolean,
  foldOverride: DiffFoldOverride,
  toggledFileKeys: ReadonlySet<string>,
): ReadonlySet<string> {
  if (isFileDiffCollapsed(fileKey, foldOverride, toggledFileKeys) === viewed)
    return toggledFileKeys;
  const next = new Set(toggledFileKeys);
  if (next.has(fileKey)) next.delete(fileKey);
  else next.add(fileKey);
  return next;
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

export interface DiffSlice {
  readonly source: PullRequestDiffResult;
  readonly cursor: string | null;
  readonly patch: string;
  readonly truncated: boolean;
  readonly nextCursor: string | null;
  readonly omittedFileStats: ReadonlyArray<PullRequestOmittedFileStat>;
}

/** Invalidates every loaded page; the tab then reads them again in order from the first. */
export function refreshPullRequestDiffPages(
  slices: ReadonlyArray<DiffSlice>,
  refreshPage: (cursor: string | null) => void,
) {
  for (const cursor of new Set([null, ...slices.map((slice) => slice.cursor)])) {
    refreshPage(cursor);
  }
}

function isSameDiffSlice(existing: DiffSlice, next: DiffSlice) {
  return (
    existing.patch === next.patch &&
    existing.truncated === next.truncated &&
    existing.nextCursor === next.nextCursor &&
    existing.omittedFileStats.length === next.omittedFileStats.length &&
    existing.omittedFileStats.every((file, index) => {
      const refreshed = next.omittedFileStats[index];
      return (
        refreshed !== undefined &&
        refreshed.path === file.path &&
        refreshed.additions === file.additions &&
        refreshed.deletions === file.deletions
      );
    })
  );
}

/**
 * Applies an arrived page and names the cursor to read next. Numeric cursors do not identify
 * content, so an unchanged page moves on to revalidate the loaded page after it.
 */
export function applyPullRequestDiffPage(
  slices: ReadonlyArray<DiffSlice>,
  next: DiffSlice,
): { readonly cursor: string | null; readonly slices: ReadonlyArray<DiffSlice> } {
  const index = slices.findIndex((slice) => slice.cursor === next.cursor);
  const existing = slices[index];
  if (existing === undefined) return { cursor: next.cursor, slices: [...slices, next] };
  if (isSameDiffSlice(existing, next)) {
    return { cursor: slices[index + 1]?.cursor ?? next.cursor, slices };
  }
  // A changed page means the diff moved under the review; later cursors were old positions.
  return { cursor: next.cursor, slices: [...slices.slice(0, index), next] };
}
