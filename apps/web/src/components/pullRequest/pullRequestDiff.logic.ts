import type { FileDiffMetadata } from "@pierre/diffs";
import type { PullRequestDiffSide } from "@t3tools/contracts";

/**
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

export type DiffFoldOverride = "expanded" | "folded" | null;

/**
 * A file the reader marked viewed opens folded every time the diff is drawn, not only in the
 * moment the box was ticked, until the toolbar folds or unfolds every file at once. A file pushed
 * to since it was marked is no longer viewed, so it opens again.
 *
 * `viewedFold` is a tick made after the toolbar unfolded everything. It folds the file only while
 * the file stays viewed, so losing the tick some other way than unticking opens it again.
 */
export function isFileDiffFoldedByDefault(input: {
  readonly foldOverride: DiffFoldOverride;
  readonly filesCollapsedSetting: boolean;
  readonly viewed: boolean;
  readonly viewedFold?: boolean;
}): boolean {
  if (input.viewed && input.viewedFold === true) return true;
  if (input.foldOverride !== null) return input.foldOverride === "folded";
  return input.filesCollapsedSetting || input.viewed;
}

/**
 * A diff arrives a slice at a time, so only the files the reader folded or unfolded by hand are
 * kept, and every other file follows its default: a file that has not loaded yet cannot be in the
 * map, and would otherwise land expanded moments after the reader folded everything. Choices are
 * kept as the state the reader asked for, not as flips of the default, because the default moves
 * when a file's viewed state arrives or a push takes it away.
 */
export function isFileDiffCollapsed(
  fileKey: string,
  foldedByDefault: boolean,
  foldChoices: ReadonlyMap<string, boolean>,
): boolean {
  return foldChoices.get(fileKey) ?? foldedByDefault;
}

/** A choice that agrees with the default is dropped, so the file goes on following it. */
export function setFileDiffFold(
  fileKey: string,
  collapsed: boolean,
  foldedByDefault: boolean,
  foldChoices: ReadonlyMap<string, boolean>,
): ReadonlyMap<string, boolean> {
  if (collapsed === foldedByDefault) {
    if (!foldChoices.has(fileKey)) return foldChoices;
    const next = new Map(foldChoices);
    next.delete(fileKey);
    return next;
  }
  if (foldChoices.get(fileKey) === collapsed) return foldChoices;
  return new Map(foldChoices).set(fileKey, collapsed);
}

export function setFileViewedFold(
  fileKey: string,
  folded: boolean,
  viewedFolds: ReadonlySet<string>,
): ReadonlySet<string> {
  if (viewedFolds.has(fileKey) === folded) return viewedFolds;
  const next = new Set(viewedFolds);
  if (folded) next.add(fileKey);
  else next.delete(fileKey);
  return next;
}
