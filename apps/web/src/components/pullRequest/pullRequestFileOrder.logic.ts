import type { FileDiffMetadata } from "@pierre/diffs";
import { orderReviewFiles } from "@t3tools/client-runtime/review-workspace";
import { resolveFileDiffPath } from "~/lib/diffRendering";
export function orderDiffFiles(files: ReadonlyArray<FileDiffMetadata>, groupByType = false) {
  return orderReviewFiles(files, resolveFileDiffPath, groupByType);
}
