import type { ChangeRequestTerminology } from "@t3tools/client-runtime/source-control-clients";
import type { PullRequestDiffResult } from "@t3tools/contracts";
import {
  buildReviewParsedDiff,
  type ReviewParsedDiff,
  type ReviewRenderableFile,
} from "../review/reviewModel";

export interface PullRequestDiffPage {
  readonly cursor: string | null;
  readonly result: PullRequestDiffResult;
}

interface CachedPullRequestDiffPages {
  readonly pages: readonly PullRequestDiffPage[];
  readonly cache: WeakMap<PullRequestDiffResult, ReviewParsedDiff>;
  readonly parsed: ReviewParsedDiff;
}

// Keep only the latest combination per scoped first page; query results own its lifetime.
const parsedSnapshots = new WeakMap<
  PullRequestDiffResult,
  Map<string, CachedPullRequestDiffPages>
>();

export function getCachedPullRequestDiffPages(
  pages: readonly PullRequestDiffPage[],
  scope: string,
  terminology: ChangeRequestTerminology,
): ReviewParsedDiff {
  const first = pages[0];
  if (!first) return { kind: "empty" };
  const key = JSON.stringify([scope, terminology.singular, first.cursor]);
  let snapshots = parsedSnapshots.get(first.result);
  if (!snapshots) {
    snapshots = new Map();
    parsedSnapshots.set(first.result, snapshots);
  }
  const previous = snapshots.get(key);
  if (
    previous?.pages.length === pages.length &&
    pages.every((page, index) => {
      const cached = previous.pages[index];
      return cached?.cursor === page.cursor && cached.result === page.result;
    })
  )
    return previous.parsed;
  const cache = previous?.cache ?? new WeakMap<PullRequestDiffResult, ReviewParsedDiff>();
  const parsed = combinePullRequestDiffPages(pages, cache, scope, terminology);
  snapshots.set(key, { pages, cache, parsed });
  return parsed;
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
      previous.withheldFilesReadable === result.withheldFilesReadable &&
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
        if (!stat) return file;
        return {
          ...file,
          additions: stat.additions,
          deletions: stat.deletions,
          ...(file.rows.length === 0 ? { notice: "Diff too large to display here." } : {}),
        };
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

/** The withheld file the reader opened, if it can be read on its own. */
export function findWithheldFile(
  parsed: ReviewParsedDiff,
  path: string | undefined,
  readable: boolean,
): ReviewRenderableFile | undefined {
  if (!readable || !path || parsed.kind !== "files") return undefined;
  return parsed.files.find((file) => file.path === path && file.rows.length === 0 && file.notice);
}

/** Puts the withheld file's own read in its place, or says why it is still missing. */
export function withWithheldFile(
  parsed: ReviewParsedDiff,
  withheld: ReviewRenderableFile,
  read: { readonly patch: string | null; readonly failed: boolean },
): ReviewParsedDiff {
  if (parsed.kind !== "files") return parsed;
  // A failed refetch still carries the earlier patch; show the failure instead of stale code.
  const loaded =
    read.patch !== null && !read.failed
      ? buildReviewParsedDiff(read.patch, `withheld:${withheld.path}`)
      : null;
  const first = loaded?.kind === "files" ? loaded.files[0] : undefined;
  const file =
    first && first.rows.length > 0
      ? first
      : {
          ...withheld,
          notice: read.failed
            ? "Couldn't load this diff."
            : loaded
              ? "No text diff for this file."
              : "Loading diff…",
        };
  return { ...parsed, files: parsed.files.map((entry) => (entry === withheld ? file : entry)) };
}
