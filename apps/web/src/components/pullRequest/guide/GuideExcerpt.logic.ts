import type { FileDiffContentsLoader, FileDiffMetadata } from "@pierre/diffs";
import {
  excerptExpansionOldContents,
  type DiffRow,
} from "@t3tools/client-runtime/review-guide-tour";
import type { PullRequestReviewGuideExcerpt } from "@t3tools/contracts";

// Other hunks shift old-side context; expand against an excerpt-matching old side.
// Loads with the source file's diff, which the loaded contents must reproduce.
export function excerptLoader(
  excerpt: PullRequestReviewGuideExcerpt,
  file: FileDiffMetadata,
  sliceRows: ReadonlyArray<DiffRow>,
  loadDiffFiles: FileDiffContentsLoader,
): FileDiffContentsLoader | null {
  // An added or deleted file has no unchanged context to expand.
  if (
    file.type === "new" ||
    file.type === "deleted" ||
    sliceRows.some((row) => row.hunk !== sliceRows[0]?.hunk)
  ) {
    return null;
  }
  return async () => {
    const loaded = await loadDiffFiles(file);
    const oldContents = excerptExpansionOldContents(loaded.newFile.contents, sliceRows);
    if (oldContents === null) return loaded;
    return {
      newFile: loaded.newFile,
      oldFile: {
        name: loaded.oldFile?.name ?? loaded.newFile.name,
        contents: oldContents,
        cacheKey: `${loaded.newFile.cacheKey ?? loaded.newFile.name}:excerpt:${excerpt.side}:${excerpt.start}-${excerpt.end}`,
      },
    };
  };
}
