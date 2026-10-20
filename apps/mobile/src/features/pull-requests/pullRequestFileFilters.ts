import { classifyChangedFile } from "@t3tools/shared/changedFileKind";
import type { ReviewParsedDiff } from "../review/reviewModel";

import { isReviewTestFile } from "@t3tools/shared/reviewFileClassification";

export const isPullRequestTestFile = isReviewTestFile;

export function filterPullRequestTestFiles(
  parsed: ReviewParsedDiff,
  hideTestFiles: boolean,
  includePath?: string,
): ReviewParsedDiff {
  if (!hideTestFiles || parsed.kind !== "files") return parsed;
  const files = parsed.files.filter(
    (file) => file.path === includePath || !isPullRequestTestFile(file.path),
  );
  if (files.length === parsed.files.length) return parsed;
  return {
    ...parsed,
    files,
    fileCount: files.length,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
  };
}
