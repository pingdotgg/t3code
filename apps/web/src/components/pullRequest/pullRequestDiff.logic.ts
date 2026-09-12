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
 * everything. Files start expanded so opening the Code tab immediately shows the change, except
 * one whose `foldedByDefault` says its reader already marked it viewed; either toolbar press
 * overrides that, and a toggle still flips whatever the default settled on.
 */
export function isFileDiffCollapsed(
  fileKey: string,
  foldOverride: DiffFoldOverride,
  toggledFileKeys: ReadonlySet<string>,
  foldedByDefault = false,
): boolean {
  const folded = foldOverride === null ? foldedByDefault : foldOverride === "folded";
  return toggledFileKeys.has(fileKey) ? !folded : folded;
}

/** Viewed marks per pull request, most recently touched pull request last. */
export type ViewedFilesByPullRequest = {
  readonly [pullRequestKey: string]: ReadonlyArray<string>;
};

/** How many pull requests keep their marks before the longest untouched fall off. */
export const MAX_VIEWED_PULL_REQUESTS = 30;
/** How many marks one pull request keeps, newest last, before the oldest fall off. */
export const MAX_VIEWED_FILES_PER_PULL_REQUEST = 1000;

/**
 * Ticks or unticks one file's Viewed mark.
 *
 * The pull request's entry is rewritten at the record's end, so the eviction drops the pull
 * requests untouched longest. Unticking the last file removes the entry entirely. Both caps
 * bound what one browser profile can accumulate: the file keys are content-derived, so every
 * push strands the keys of the files it changed.
 */
export function toggleViewedFile(
  current: ViewedFilesByPullRequest,
  pullRequestKey: string,
  fileKey: string,
): ViewedFilesByPullRequest {
  const fileKeys = new Set(current[pullRequestKey] ?? []);
  if (fileKeys.has(fileKey)) fileKeys.delete(fileKey);
  else fileKeys.add(fileKey);
  const next: Record<string, ReadonlyArray<string>> = {};
  for (const [key, value] of Object.entries(current)) {
    if (key !== pullRequestKey) next[key] = value;
  }
  if (fileKeys.size > 0) {
    next[pullRequestKey] = [...fileKeys].slice(-MAX_VIEWED_FILES_PER_PULL_REQUEST);
  }
  const pullRequestKeys = Object.keys(next);
  const excess = Math.max(0, pullRequestKeys.length - MAX_VIEWED_PULL_REQUESTS);
  for (const key of pullRequestKeys.slice(0, excess)) {
    delete next[key];
  }
  return next;
}
