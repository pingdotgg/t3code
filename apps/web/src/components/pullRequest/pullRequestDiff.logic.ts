import type { FileDiffMetadata } from "@pierre/diffs";
import type { PullRequestDiffSide } from "@t3tools/contracts";

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

/** What the toolbar last asked of every file at once, null being the reader asking nothing yet. */
export type DiffFoldOverride = "expanded" | "folded" | null;

/**
 * Whether a file is drawn folded.
 *
 * A diff arrives a slice at a time, so the reader's own choices are kept as the difference from
 * what the toolbar last said rather than as the set of folded files: a file that has not loaded
 * yet cannot be in a set, and would otherwise land expanded moments after the reader folded
 * everything. Files start expanded so opening the Code tab immediately shows the change; the
 * reader can still fold individual files or the whole diff from the toolbar.
 */
export function isFileDiffCollapsed(
  fileKey: string,
  foldOverride: DiffFoldOverride,
  toggledFileKeys: ReadonlySet<string>,
): boolean {
  const foldedByDefault = foldOverride === "folded";
  return toggledFileKeys.has(fileKey) ? !foldedByDefault : foldedByDefault;
}
