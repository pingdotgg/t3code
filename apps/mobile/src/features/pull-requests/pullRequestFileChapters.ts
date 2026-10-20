import { reviewFileChapters, isReviewTestFile } from "@t3tools/shared/reviewFileClassification";

export function pullRequestFileChapters(input: {
  readonly completePaths: ReadonlyArray<string> | null;
  readonly loadedPaths: ReadonlyArray<string>;
  readonly visiblePaths: ReadonlyArray<string>;
  readonly hideTestFiles: boolean;
  readonly includePath?: string | undefined;
}) {
  // Diff pages carry code in batches; only a complete index can answer chapter totals.
  const paths = (input.completePaths ?? input.loadedPaths).filter(
    (path) => !input.hideTestFiles || path === input.includePath || !isReviewTestFile(path),
  );
  return {
    complete: input.completePaths !== null,
    chapters: reviewFileChapters(paths, (path) => path, input.visiblePaths),
  };
}
