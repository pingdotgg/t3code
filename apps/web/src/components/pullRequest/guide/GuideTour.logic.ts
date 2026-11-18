import type { FileDiffMetadata } from "@pierre/diffs";

export function guideViewedFiles(
  files: ReadonlyMap<string, FileDiffMetadata>,
  paths: ReadonlyArray<string>,
): ReadonlyArray<{ path: string; revision: string }> | null {
  const revisions: Array<{ path: string; revision: string }> = [];
  for (const path of paths) {
    const revision = files.get(path)?.newObjectId;
    if (!revision) return null;
    revisions.push({ path, revision });
  }
  return revisions;
}
