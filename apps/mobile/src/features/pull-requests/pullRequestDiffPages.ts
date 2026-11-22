import { orderDiffFilesForReview } from "@t3tools/client-runtime/diff-file-order";
import type { ChangeRequestTerminology } from "@t3tools/client-runtime/source-control-clients";
import { changeRequestTermKind } from "../../lib/changeRequestTerm";
import type { PullRequestDiffResult } from "@t3tools/contracts";
import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";
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
  resolve: MessageResolver = m,
  locale = "",
): ReviewParsedDiff {
  const first = pages[0];
  if (!first) return { kind: "empty" };
  const key = JSON.stringify([scope, terminology.singular, first.cursor, locale]);
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
  const parsed = combinePullRequestDiffPages(pages, cache, scope, terminology, resolve);
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
  resolve: MessageResolver = m,
): ReviewParsedDiff {
  const parsed = pages.map((page) => {
    const cached = cache.get(page.result);
    if (cached) return cached;
    let value = buildReviewParsedDiff(
      page.result.patch,
      `${scope}:${page.cursor ?? "first"}`,
      resolve,
    );
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
          ...(file.rows.length === 0 ? { withheld: true } : {}),
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
  const files = orderDiffFilesForReview(
    parsed.flatMap((page) => (page.kind === "files" ? page.files : [])),
    (file) => file.path,
  );
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
        ? resolve(
            msg(
              "Some file contents are unavailable. Open the {term, select, mr {merge request} cr {change request} other {pull request}} on its provider to see the full changes.",
              { term: changeRequestTermKind(terminology) },
            ),
          )
        : null,
  };
}

export type WithheldFileLoad =
  | { readonly status: "loading" | "error" }
  | { readonly status: "loaded"; readonly result: PullRequestDiffResult };

const withheldFileParses = new WeakMap<
  PullRequestDiffResult,
  { readonly locale: string; readonly file: ReviewRenderableFile | null }
>();

function parseWithheldFile(
  result: PullRequestDiffResult,
  scope: string,
  resolve: MessageResolver,
  locale: string,
) {
  const cached = withheldFileParses.get(result);
  if (cached?.locale === locale) return cached.file;
  const parsed = buildReviewParsedDiff(result.patch, scope, resolve);
  const file =
    parsed.kind === "files" ? (parsed.files.find((entry) => entry.rows.length > 0) ?? null) : null;
  withheldFileParses.set(result, { locale, file });
  return file;
}

function withheldFileNotice(
  load: WithheldFileLoad | undefined,
  canLoad: boolean,
  resolve: MessageResolver,
): string {
  if (load === undefined) {
    return canLoad
      ? resolve(msg("Diff too large to display. Tap to load it."))
      : resolve(msg("Diff too large to display here."));
  }
  if (load.status === "loading") return resolve(msg("Loading diff…"));
  if (load.status === "error") return resolve(msg("Couldn't load this diff. Tap to try again."));
  return resolve(msg("No text diff for this file."));
}

/**
 * Puts each loaded withheld file in place of its empty one, under the same id so folds and
 * targets hold, and gives the rest a notice saying what a tap does.
 */
export function withWithheldFiles(
  parsed: ReviewParsedDiff,
  loads: ReadonlyMap<string, WithheldFileLoad>,
  canLoad: boolean,
  scope: string,
  resolve: MessageResolver = m,
  locale = "",
): ReviewParsedDiff {
  if (parsed.kind !== "files" || !parsed.files.some((file) => file.withheld)) return parsed;
  const files = parsed.files.map((file): ReviewRenderableFile => {
    if (!file.withheld) return file;
    const load = loads.get(file.path);
    const loaded =
      load?.status === "loaded"
        ? parseWithheldFile(load.result, `${scope}:withheld:${file.path}`, resolve, locale)
        : null;
    if (loaded !== null) return { ...loaded, id: file.id };
    return {
      ...file,
      notice: withheldFileNotice(load, canLoad, resolve),
      noticeTone: "warning",
      noticeActionable: canLoad && (load === undefined || load.status === "error"),
    };
  });
  return {
    ...parsed,
    files,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
  };
}
