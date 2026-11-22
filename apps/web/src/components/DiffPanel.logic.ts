import type { FileDiffMetadata } from "@pierre/diffs";

import { getDiffLineStat, resolveFileDiffPath } from "~/lib/diffRendering";

/** One turn diffs against the checkpoint before it; all turns diff against the thread's first. */
export function checkpointDiffRange(
  turnCount: number | undefined,
  cumulative: boolean,
): { fromTurnCount: number; toTurnCount: number } | null {
  if (turnCount === undefined) return null;
  return {
    fromTurnCount: cumulative ? 0 : Math.max(0, turnCount - 1),
    toTurnCount: turnCount,
  };
}

export interface DiffFileListRow {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

/**
 * One row per path, in diff order. A file whose patch has not loaded yet has no hunks, so
 * its stat comes from the source's metadata when the source has it.
 */
export function diffFileListRows(
  files: ReadonlyArray<FileDiffMetadata>,
  stats: ReadonlyMap<string, { readonly additions: number; readonly deletions: number }>,
): DiffFileListRow[] {
  const rows = new Map<string, { additions: number; deletions: number }>();
  for (const file of files) {
    const path = resolveFileDiffPath(file);
    const stat = stats.get(path) ?? getDiffLineStat([file]);
    const row = rows.get(path);
    if (row && !stats.has(path)) {
      row.additions += stat.additions;
      row.deletions += stat.deletions;
    } else if (!row) {
      rows.set(path, { additions: stat.additions, deletions: stat.deletions });
    }
  }
  return [...rows].map(([path, stat]) => ({ path, ...stat }));
}
