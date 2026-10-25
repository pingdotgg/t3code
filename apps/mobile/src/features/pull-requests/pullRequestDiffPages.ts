import type { ChangeRequestTerminology } from "@t3tools/client-runtime/source-control-clients";
import type { PullRequestDiffResult } from "@t3tools/contracts";
import { buildReviewParsedDiff, type ReviewParsedDiff } from "../review/reviewModel";

export interface PullRequestDiffPage {
  readonly cursor: string | null;
  readonly result: PullRequestDiffResult;
}

/** A changed page invalidates later cursors, which belong to the previous patch. */
export function retainPullRequestDiffPage(
  pages: readonly PullRequestDiffPage[],
  cursor: string | null,
  result: PullRequestDiffResult,
): readonly PullRequestDiffPage[] {
  const index = pages.findIndex((page) => page.cursor === cursor);
  if (index === -1) return [...pages, { cursor, result }];
  const previous = pages[index]?.result;
  if (
    previous === result ||
    (previous?.patch === result.patch &&
      previous.truncated === result.truncated &&
      previous.nextCursor === result.nextCursor &&
      JSON.stringify(previous.omittedFileStats ?? []) ===
        JSON.stringify(result.omittedFileStats ?? []))
  )
    return pages;
  return [...pages.slice(0, index), { cursor, result }];
}

export function combinePullRequestDiffPages(
  pages: readonly PullRequestDiffPage[],
  cache: WeakMap<PullRequestDiffResult, ReviewParsedDiff>,
  scope: string,
  terminology: ChangeRequestTerminology,
): ReviewParsedDiff {
  const parsed = pages.map((page) => {
    const cached = cache.get(page.result);
    if (cached) return cached;
    let value = buildReviewParsedDiff(page.result.patch, `${scope}:${page.cursor ?? "first"}`);
    if (value.kind === "files" && page.result.omittedFileStats?.length) {
      const omittedFileStats = new Map(
        page.result.omittedFileStats.map((stat) => [stat.path, stat]),
      );
      const files = value.files.map((file) => {
        const stat = omittedFileStats.get(file.path);
        return stat ? { ...file, additions: stat.additions, deletions: stat.deletions } : file;
      });
      value = {
        ...value,
        files,
        additions: files.reduce((total, file) => total + file.additions, 0),
        deletions: files.reduce((total, file) => total + file.deletions, 0),
      };
    }
    cache.set(page.result, value);
    return value;
  });
  const files = parsed.flatMap((page) => (page.kind === "files" ? page.files : []));
  if (files.length === 0) return parsed[0] ?? { kind: "empty" };
  return {
    kind: "files",
    files,
    fileCount: files.length,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
    notice:
      pages.some((page) => page.result.truncated) ||
      parsed.some((page) => page.kind === "raw" || (page.kind === "files" && page.notice !== null))
        ? `Some file contents are unavailable. Open the ${terminology.singular} on its provider to see the full changes.`
        : null,
  };
}
