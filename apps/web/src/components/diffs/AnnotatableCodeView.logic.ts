import type { FileDiffMetadata } from "@pierre/diffs";

import { resolveFileDiffPath, resolveFileDiffPreviousPath } from "~/lib/diffRendering";

export interface DiffCommentAnchor {
  readonly fileKey: string;
  readonly filePath: string;
  readonly previousFilePath: string;
  readonly fileVersion: number;
}

export function isDiffCommentAnchorCurrent(
  anchor: DiffCommentAnchor,
  filesByKey: ReadonlyMap<
    string,
    { readonly fileVersion: number; readonly fileDiff: FileDiffMetadata }
  >,
  pendingFiles: ReadonlyArray<FileDiffMetadata>,
): boolean {
  const file = filesByKey.get(anchor.fileKey);
  if (file !== undefined && !file.fileDiff.cacheKey?.endsWith(":pending")) {
    return file.fileVersion === anchor.fileVersion;
  }
  // Lazy placeholders have provisional change types, so match both paths instead.
  return pendingFiles.some(
    (file) =>
      resolveFileDiffPath(file) === anchor.filePath &&
      resolveFileDiffPreviousPath(file) === anchor.previousFilePath,
  );
}
