import type { ReviewParsedDiff } from "../review/reviewModel";

/** Match test paths, not source names such as `testing.ts` or `contest.ts`. */
export function isPullRequestTestFile(path: string): boolean {
  const segments = path.replaceAll("\\", "/").split("/");
  const name = segments.at(-1) ?? "";
  return (
    segments
      .slice(0, -1)
      .some((segment) => /^(?:__tests__|__snapshots__|tests?|spec|e2e)$/i.test(segment)) ||
    /\.(?:test|spec)\./i.test(name) ||
    /\.snap$/i.test(name) ||
    /^(?:test_.+|.+_test)\.py$/i.test(name) ||
    /_test\.(?:go|rs|rb|c|cc|cpp|h|hpp)$/i.test(name) ||
    /(?:Test|Tests|Spec)\.(?:java|kt|kts|swift|cs)$/.test(name) ||
    /_spec\.rb$/i.test(name)
  );
}

/** Keep original files and line IDs so hiding tests cannot move review anchors. */
export function filterPullRequestTestFiles(
  parsed: ReviewParsedDiff,
  hideTestFiles: boolean,
): ReviewParsedDiff {
  if (!hideTestFiles || parsed.kind !== "files") return parsed;
  const files = parsed.files.filter((file) => !isPullRequestTestFile(file.path));
  if (files.length === parsed.files.length) return parsed;
  return {
    ...parsed,
    files,
    fileCount: files.length,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
  };
}
