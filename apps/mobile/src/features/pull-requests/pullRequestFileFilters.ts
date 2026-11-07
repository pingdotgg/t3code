import { isDocumentationChangedFile, isTestChangedFile } from "@t3tools/shared/changedFileKind";
import type { ReviewParsedDiff } from "../review/reviewModel";

export type PullRequestFileFilterOptions = {
  readonly hideTestFiles?: boolean;
  readonly hideDocumentationFiles?: boolean;
  readonly includePath?: string;
};

function isHiddenPullRequestFile(path: string, options: PullRequestFileFilterOptions) {
  if (options.hideTestFiles && isTestChangedFile(path)) return true;
  if (options.hideDocumentationFiles && isDocumentationChangedFile(path)) return true;
  return false;
}

export function filterPullRequestFiles(
  parsed: ReviewParsedDiff,
  options: PullRequestFileFilterOptions,
): ReviewParsedDiff {
  if ((!options.hideTestFiles && !options.hideDocumentationFiles) || parsed.kind !== "files") {
    return parsed;
  }
  const files = parsed.files.filter(
    (file) => file.path === options.includePath || !isHiddenPullRequestFile(file.path, options),
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
