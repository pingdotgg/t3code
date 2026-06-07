import type { FileDiffMetadata } from "@pierre/diffs";

import { resolveFileDiffPath } from "./diffRendering";
import type { TurnDiffFileChange } from "../types";

export function countFileDiffStat(fileDiff: FileDiffMetadata): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const hunk of fileDiff.hunks) {
    additions += hunk.additionLines;
    deletions += hunk.deletionLines;
  }
  return { additions, deletions };
}

/**
 * Adapts the parsed diff metadata that the diff surface renders into the
 * `TurnDiffFileChange` shape consumed by `buildTurnDiffTree`/`ChangedFilesTree`.
 *
 * Driving the tree from the same parsed patch the body renders keeps the
 * navigation rail perfectly in sync with the diff (renames, binary files, and
 * partial patches included), instead of relying on the turn summary which can
 * lag the actual checkpoint patch.
 */
export function adaptFileDiffsToTreeChanges(
  files: ReadonlyArray<FileDiffMetadata>,
): TurnDiffFileChange[] {
  return files.map((fileDiff) => {
    const { additions, deletions } = countFileDiffStat(fileDiff);
    return {
      path: resolveFileDiffPath(fileDiff),
      kind: fileDiff.type,
      additions,
      deletions,
    };
  });
}
