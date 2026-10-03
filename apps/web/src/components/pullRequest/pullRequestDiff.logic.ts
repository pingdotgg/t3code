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
 * everything. The caller supplies the saved default until the toolbar overrides it; individual
 * files can still be toggled independently.
 */
export function isFileDiffCollapsed(
  fileKey: string,
  foldOverride: DiffFoldOverride,
  toggledFileKeys: ReadonlySet<string>,
): boolean {
  const foldedByDefault = foldOverride === "folded";
  return toggledFileKeys.has(fileKey) ? !foldedByDefault : foldedByDefault;
}

/**
 * The reader's fold choices after a file was ticked off, or put back.
 *
 * Clearing a file puts it away and un-clearing brings it back, so the tick moves the fold as if
 * the reader had pressed the chevron themselves, which keeps folding a difference from what the
 * toolbar last asked, and so keeps "collapse all" from ticking anything off.
 */
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

/**
 * Folds, once, the files the reader had already ticked off before this mount of the Code tab,
 * the way their ticks would have. The fold set is local to the tab and starts empty on every
 * mount, while the ticks live on the host; without this a ticked file comes back open each time
 * the reader returns to Code. Every file seen is remembered, so a file ticked or unfolded later
 * is left to the reader's own choices; both sets come back unchanged when there is nothing to do.
 */
export function foldViewedFilesOnce(
  files: ReadonlyArray<{
    readonly fileKey: string;
    /** Survives what `fileKey` does not, such as a whitespace toggle re-keying every diff. */
    readonly path: string;
    readonly viewed: boolean;
  }>,
  seenPaths: ReadonlySet<string>,
  foldOverride: DiffFoldOverride,
  toggledFileKeys: ReadonlySet<string>,
): {
  readonly seenPaths: ReadonlySet<string>;
  readonly toggledFileKeys: ReadonlySet<string>;
} {
  const unseen = files.filter((file) => !seenPaths.has(file.path));
  if (unseen.length === 0) return { seenPaths, toggledFileKeys };
  const seen = new Set(seenPaths);
  let toggled = toggledFileKeys;
  for (const file of unseen) {
    seen.add(file.path);
    if (file.viewed)
      toggled = toggleFileDiffFoldForViewed(file.fileKey, true, foldOverride, toggled);
  }
  return { seenPaths: seen, toggledFileKeys: toggled };
}
