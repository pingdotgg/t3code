import { isTestChangedFile } from "@t3tools/shared/changedFileKind";
import type { ReviewParsedDiff } from "../review/reviewModel";

export function filterPullRequestTestFiles(
  parsed: ReviewParsedDiff,
  hideTestFiles: boolean,
  includePath?: string,
): ReviewParsedDiff {
  if (!hideTestFiles || parsed.kind !== "files") return parsed;
  const files = parsed.files.filter(
    (file) => file.path === includePath || !isTestChangedFile(file.path),
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

/** Patches to load around `index` (or from the top): the next three files the review will show. */
export function shownPatchIndices(
  files: ReadonlyArray<{ readonly path: string }>,
  hideTestFiles: boolean,
  index: number | null,
): ReadonlyArray<number> {
  const shown = files.flatMap((file, position) =>
    hideTestFiles && isTestChangedFile(file.path) ? [] : [position],
  );
  if (index === null) return shown.slice(0, 3);
  const position = shown.indexOf(index);
  return position < 0 ? [index] : shown.slice(position, position + 3);
}
