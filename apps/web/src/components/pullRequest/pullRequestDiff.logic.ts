import type { FileDiffMetadata } from "@pierre/diffs";
import type { PullRequestDiffSide, PullRequestOmittedFileStat } from "@t3tools/contracts";

import { resolveFileDiffPath } from "~/lib/diffRendering";

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

/** Host totals stay stable while patches arrive; individual previews may omit hunks. */
export function getPullRequestDiffStats(input: {
  files: ReadonlyArray<FileDiffMetadata>;
  omittedFileStats: ReadonlyMap<string, PullRequestOmittedFileStat>;
  totals: { additions: number; deletions: number; changedFiles: number } | null;
}) {
  const loaded = input.files.reduce(
    (total, file) => {
      const stat = input.omittedFileStats.get(resolveFileDiffPath(file));
      return {
        changedFiles: total.changedFiles + 1,
        additions:
          total.additions +
          (stat?.additions ?? file.hunks.reduce((sum, hunk) => sum + hunk.additionLines, 0)),
        deletions:
          total.deletions +
          (stat?.deletions ?? file.hunks.reduce((sum, hunk) => sum + hunk.deletionLines, 0)),
      };
    },
    { additions: 0, deletions: 0, changedFiles: 0 },
  );
  // Some hosts omit totals, and detail can lag a newly pushed patch.
  return input.totals === null
    ? loaded
    : {
        additions: Math.max(input.totals.additions, loaded.additions),
        deletions: Math.max(input.totals.deletions, loaded.deletions),
        changedFiles: Math.max(input.totals.changedFiles, loaded.changedFiles),
      };
}
