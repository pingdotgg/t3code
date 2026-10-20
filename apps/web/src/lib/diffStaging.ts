import type { FileDiffMetadata } from "@pierre/diffs";
import type { ReviewDiffPreviewSource, VcsStatusResult } from "@t3tools/contracts";

import { resolveFileDiffPath, resolveFileDiffPreviousPath } from "./diffRendering";

export type UncommittedSection = "staged" | "unstaged";

export function fileDiffStagingPaths(fileDiff: FileDiffMetadata): string[] {
  return [...new Set([resolveFileDiffPath(fileDiff), resolveFileDiffPreviousPath(fileDiff)])];
}

/**
 * Every path in a section. Status lists all changed files even when the preview is truncated or
 * leaves out untracked files, so it is preferred over the preview's own file list.
 */
export function sectionPaths(input: {
  readonly section: UncommittedSection;
  readonly statusFiles: VcsStatusResult["workingTree"]["files"];
  readonly source: ReviewDiffPreviewSource;
  readonly renderedFiles: ReadonlyArray<FileDiffMetadata>;
}): string[] {
  if (input.statusFiles.length > 0 && input.statusFiles.every((file) => file.staged)) {
    const excluded = input.section === "staged" ? "none" : "all";
    return input.statusFiles.flatMap((file) => (file.staged === excluded ? [] : [file.path]));
  }
  const paths = input.source.files
    ? input.source.files.flatMap((file) => [
        file.path,
        ...(file.previousPath ? [file.previousPath] : []),
      ])
    : input.renderedFiles.flatMap(fileDiffStagingPaths);
  return [...new Set(paths)];
}
