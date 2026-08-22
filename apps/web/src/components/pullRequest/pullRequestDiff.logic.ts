import type { FileDiffMetadata } from "@pierre/diffs";
import type { PullRequestDiffSide } from "@t3tools/contracts";

/**
 * Reconciles the host's aggregate file count with the files and cursor actually loaded.
 *
 * Some hosts report a lower bound such as GitLab's `1000+`. Once the loaded diff reaches that
 * bound while another slice remains, the count is no longer a usable total: presenting it as a
 * denominator would make an incomplete diff look finished.
 */
export function getPullRequestFileLoadState(
  loadedFileCount: number,
  reportedTotalFileCount: number | null,
  hasMore: boolean,
) {
  const displayedFileCount = Math.max(reportedTotalFileCount ?? 0, loadedFileCount);
  const reportedCountIsExhausted =
    reportedTotalFileCount === null || loadedFileCount >= reportedTotalFileCount;
  const displayedCountIsLowerBound = hasMore && reportedCountIsExhausted;
  return {
    displayedFileCount,
    knownTotalFileCount: displayedCountIsLowerBound ? null : displayedFileCount,
    displayedCountIsLowerBound,
  };
}

/**
 * Whether a conversation's line is really in this file's hunks.
 *
 * A thread naming a file is not the same as a thread the diff can show: its line may have moved
 * out of the change, or sit in a hunk the host withheld. Pinning it anyway would put the remark
 * against whatever code now occupies that line number, and silently dropping it would lose the
 * conversation, so the answer decides which of the two lists it belongs in.
 */
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

/** The current bulk expansion preference for pull request diffs. */
export type DiffFoldPreference = "expanded" | "folded";

/**
 * Whether a file is drawn folded.
 *
 * A diff arrives a slice at a time, so the reader's own choices are kept as the difference from
 * what the toolbar last said rather than as the set of folded files: a file that has not loaded
 * yet cannot be in a set, and would otherwise ignore the reader's last all-files choice. Files
 * begin expanded so opening Code immediately shows the change; the toolbar can still fold every
 * loaded and future slice in one action.
 */
export function isFileDiffCollapsed(
  fileKey: string,
  foldPreference: DiffFoldPreference,
  toggledFileKeys: ReadonlySet<string>,
): boolean {
  const foldedByDefault = foldPreference === "folded";
  return toggledFileKeys.has(fileKey) ? !foldedByDefault : foldedByDefault;
}
