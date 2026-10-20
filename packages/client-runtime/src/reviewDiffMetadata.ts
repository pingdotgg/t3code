import { processFile } from "@pierre/diffs/utils/parsePatchFiles";
import type { FileContents } from "@pierre/diffs/types";
import { createTwoFilesPatch } from "diff";

/** Keep shared diff arithmetic usable in native clients without loading web components. */
export function parseReviewDiffFromFiles(
  oldFile: FileContents,
  newFile: FileContents,
  options?: { context?: number },
) {
  const patch = createTwoFilesPatch(
    oldFile.name,
    newFile.name,
    oldFile.contents,
    newFile.contents,
    oldFile.header,
    newFile.header,
    options,
  );
  const file = processFile(patch, { oldFile, newFile, throwOnError: true });
  if (!file) throw new Error("Could not parse the working file comparison");
  return file;
}
