import * as NodeModule from "node:module";

import type {
  DirItem,
  DirSearchResult,
  FileItem,
  FileFinder as FileFinderType,
  GrepCursor,
  MixedItem,
  MixedSearchResult,
  Result,
  SearchResult,
} from "@ff-labs/fff-node";
import * as Effect from "effect/Effect";

import type {
  ProjectEntry,
  ProjectSearchContentsInput,
  ProjectSearchContentsResult,
  ProjectSearchEntriesResult,
} from "@t3tools/contracts";
import { isWorkspaceImagePreviewPath } from "@t3tools/shared/filePreview";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as WorkspaceSearchIndexService from "./WorkspaceSearchIndexService.ts";

export * from "./WorkspaceSearchIndexService.ts";

// The native loader must resolve from disk inside the standalone executable.
const requireForFff = NodeModule.createRequire(import.meta.url);
const { FileFinder } = requireForFff("@ff-labs/fff-node") as typeof import("@ff-labs/fff-node");

const WORKSPACE_INDEX_SCAN_TIMEOUT = "15 seconds";
const WORKSPACE_INDEX_SCAN_TIMEOUT_MS = 15_000;
const CONTENT_SEARCH_TIME_BUDGET_MS = 250;
const CONTENT_SEARCH_MAX_MATCHES_PER_FILE = 100;
const CONTENT_SEARCH_MAX_CANDIDATES = 25_000;

function toPosixPath(input: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? input.replaceAll("\\", "/") : input;
}

function trimDirectorySeparator(input: string): string {
  return input.endsWith("/") ? input.slice(0, -1) : input;
}

function parentPathOf(input: string): string | undefined {
  const separatorIndex = input.lastIndexOf("/");
  return separatorIndex === -1 ? undefined : input.slice(0, separatorIndex);
}

function toProjectEntry(item: MixedItem, platform: NodeJS.Platform): ProjectEntry | null {
  const normalizedPath = trimDirectorySeparator(toPosixPath(item.item.relativePath, platform));
  if (!normalizedPath) {
    return null;
  }

  return {
    path: normalizedPath,
    kind: item.type,
  };
}

function toFileEntry(item: FileItem, platform: NodeJS.Platform): ProjectEntry | null {
  const normalizedPath = trimDirectorySeparator(toPosixPath(item.relativePath, platform));
  return normalizedPath ? { path: normalizedPath, kind: "file" } : null;
}

function toDirectoryEntry(item: DirItem, platform: NodeJS.Platform): ProjectEntry | null {
  const normalizedPath = trimDirectorySeparator(toPosixPath(item.relativePath, platform));
  return normalizedPath ? { path: normalizedPath, kind: "directory" } : null;
}

function mapFileSearchResult(
  result: SearchResult,
  limit: number,
  platform: NodeJS.Platform,
  imageOnly = false,
): ProjectSearchEntriesResult {
  const entries = result.items.flatMap((item) => {
    const entry = toFileEntry(item, platform);
    return entry && (!imageOnly || isWorkspaceImagePreviewPath(entry.path)) ? [entry] : [];
  });
  return {
    entries: entries.slice(0, limit),
    truncated: entries.length > limit || result.totalMatched > result.items.length,
  };
}

function mapDirectorySearchResult(
  result: DirSearchResult,
  limit: number,
  platform: NodeJS.Platform,
): ProjectSearchEntriesResult {
  const entries = result.items.flatMap((item) => {
    const entry = toDirectoryEntry(item, platform);
    return entry ? [entry] : [];
  });
  const rootDirectoryCount = result.items.some((item) => item.relativePath.length === 0) ? 1 : 0;
  return {
    entries: entries.slice(0, limit),
    truncated: result.totalMatched - rootDirectoryCount > limit,
  };
}

function mapMixedSearchResult(
  result: MixedSearchResult,
  limit: number,
  platform: NodeJS.Platform,
): { readonly entries: ProjectEntry[]; readonly truncated: boolean } {
  const entries: ProjectEntry[] = [];
  for (const item of result.items) {
    const entry = toProjectEntry(item, platform);
    if (entry) {
      entries.push(entry);
    }
    if (entries.length >= limit) {
      break;
    }
  }

  const rootDirectoryCount = result.items.some(
    (item) => item.type === "directory" && item.item.relativePath.length === 0,
  )
    ? 1
    : 0;
  return {
    entries,
    truncated: result.totalMatched - rootDirectoryCount > limit,
  };
}

const WORD_CHARACTER = /[\p{Letter}\p{Mark}\p{Number}_]/u;

function codePointAt(line: string, index: number): string | undefined {
  const codePoint = line.codePointAt(index);
  return codePoint === undefined ? undefined : String.fromCodePoint(codePoint);
}

function codePointBefore(line: string, index: number): string | undefined {
  if (index <= 0) return undefined;
  const previousCodeUnit = line.charCodeAt(index - 1);
  const previousIndex =
    previousCodeUnit >= 0xdc00 && previousCodeUnit <= 0xdfff ? index - 2 : index - 1;
  return codePointAt(line, previousIndex);
}

function buildContentSearchQuery(input: Omit<ProjectSearchContentsInput, "cwd">): {
  readonly searchQuery: string;
  readonly regexMode: boolean;
} {
  if (input.caseSensitive) {
    return { searchQuery: input.query, regexMode: input.useRegex };
  }
  // Plain mode relies on smart case: an all-lowercase needle matches
  // case-insensitively. Regex mode needs an explicit inline flag instead.
  return input.useRegex
    ? { searchQuery: `(?i)${input.query}`, regexMode: true }
    : { searchQuery: input.query.toLowerCase(), regexMode: false };
}

function mapContentMatchRanges(
  line: string,
  byteRanges: ReadonlyArray<readonly [number, number]>,
): Array<{ readonly start: number; readonly end: number }> {
  const lineBytes = Buffer.from(line);
  const toStringIndex = (byteOffset: number) => lineBytes.subarray(0, byteOffset).toString().length;
  return byteRanges.map(([startByte, endByte]) => ({
    start: toStringIndex(startByte),
    end: toStringIndex(endByte),
  }));
}

/**
 * Whole-word filtering happens after the grep rather than by wrapping the
 * pattern in boundary regex: consuming boundaries such as `(?:^|\W)` swallow
 * the separator between adjacent matches and widen the reported ranges, and
 * `\b` cannot match punctuation-edged queries at all. Matching VS Code, a
 * match edge is a word boundary when it touches the line edge, the
 * neighbouring character is not a word character, or the match's own edge
 * character is not a word character.
 */
function isWholeWordRange(
  line: string,
  range: { readonly start: number; readonly end: number },
): boolean {
  if (range.end <= range.start) return false;
  const isWord = (character: string | undefined) =>
    character !== undefined && WORD_CHARACTER.test(character);
  const leftIsBoundary =
    range.start === 0 ||
    !isWord(codePointBefore(line, range.start)) ||
    !isWord(codePointAt(line, range.start));
  const rightIsBoundary =
    range.end >= line.length ||
    !isWord(codePointAt(line, range.end)) ||
    !isWord(codePointBefore(line, range.end));
  return leftIsBoundary && rightIsBoundary;
}

function withDirectoryAncestors(entries: ReadonlyArray<ProjectEntry>): ProjectEntry[] {
  const entryByPath = new Map(entries.map((entry) => [entry.path, entry]));
  for (const entry of entries) {
    let parentPath = parentPathOf(entry.path);
    while (parentPath) {
      if (!entryByPath.has(parentPath)) {
        entryByPath.set(parentPath, { path: parentPath, kind: "directory" });
      }
      parentPath = parentPathOf(parentPath);
    }
  }
  return [...entryByPath.values()];
}

const createFinder = Effect.fn("WorkspaceSearchIndex.createFinder")(function* (
  cwd: string,
  variant: WorkspaceSearchIndexService.WorkspaceSearchIndexVariant,
) {
  const result = yield* Effect.try({
    try: () =>
      FileFinder.create({
        basePath: cwd,
        disableMmapCache: true,
        // Content indexing costs scan CPU and memory, so only the on-demand
        // content-search index pays for it; path-only consumers (file tree,
        // composer path search, file picker) keep the lightweight index.
        disableContentIndexing: variant !== "content",
        aiMode: false,
        enableFsRootScanning: true,
        enableHomeDirScanning: true,
      }),
    catch: (cause) =>
      new WorkspaceSearchIndexService.WorkspaceSearchIndexCreateFailed({
        cwd,
        reason: "FileFinder.create threw unexpectedly.",
        cause,
      }),
  });
  if (result.ok) return result.value;
  return yield* new WorkspaceSearchIndexService.WorkspaceSearchIndexCreateFailed({
    cwd,
    reason: result.error,
  });
});

const waitForIndexReady = Effect.fn("WorkspaceSearchIndex.waitForIndexReady")(function* <E>(
  cwd: string,
  finder: FileFinderType,
  onFailure: (input: { readonly reason: string; readonly cause?: unknown }) => E,
): Effect.fn.Return<void, E | WorkspaceSearchIndexService.WorkspaceSearchIndexScanTimedOut> {
  const result = yield* Effect.tryPromise({
    try: () => finder.waitForIndexReady(WORKSPACE_INDEX_SCAN_TIMEOUT_MS),
    catch: (cause) =>
      onFailure({
        reason: "FileFinder.waitForIndexReady rejected unexpectedly.",
        cause,
      }),
  });
  if (!result.ok) {
    return yield* Effect.fail(onFailure({ reason: result.error }));
  }
  if (!result.value) {
    return yield* new WorkspaceSearchIndexService.WorkspaceSearchIndexScanTimedOut({
      cwd,
      timeout: WORKSPACE_INDEX_SCAN_TIMEOUT,
    });
  }
});

export const make = Effect.fn("WorkspaceSearchIndex.make")(function* (
  cwd: string,
  variant: WorkspaceSearchIndexService.WorkspaceSearchIndexVariant = "paths",
) {
  const platform = yield* HostProcessPlatform;
  const finder = yield* Effect.acquireRelease(createFinder(cwd, variant), (finder) =>
    Effect.try({
      try: () => finder.destroy(),
      catch: (cause) =>
        new WorkspaceSearchIndexService.WorkspaceSearchIndexDestroyFailed({ cwd, cause }),
    }).pipe(Effect.orDie),
  );
  yield* waitForIndexReady(
    cwd,
    finder,
    ({ reason, cause }) =>
      new WorkspaceSearchIndexService.WorkspaceSearchIndexCreateFailed({
        cwd,
        reason,
        cause,
      }),
  );

  const runSearch = Effect.fn("WorkspaceSearchIndex.runSearch")(function* <A>(
    query: string,
    pageSize: number,
    operation: "directorySearch" | "fileSearch" | "grep" | "mixedSearch",
    execute: () => Result<A>,
  ): Effect.fn.Return<A, WorkspaceSearchIndexService.WorkspaceSearchIndexSearchFailed> {
    const result = yield* Effect.try({
      try: execute,
      catch: (cause) =>
        new WorkspaceSearchIndexService.WorkspaceSearchIndexSearchFailed({
          cwd,
          queryLength: query.length,
          pageSize,
          reason: `FileFinder.${operation} threw unexpectedly.`,
          cause,
        }),
    });
    if (!result.ok) {
      return yield* new WorkspaceSearchIndexService.WorkspaceSearchIndexSearchFailed({
        cwd,
        queryLength: query.length,
        pageSize,
        reason: result.error,
      });
    }
    return result.value;
  });

  const refresh: WorkspaceSearchIndexService.WorkspaceSearchIndex["Service"]["refresh"] = Effect.fn(
    "WorkspaceSearchIndex.refresh",
  )(function* () {
    const result = yield* Effect.try({
      try: () => finder.scanFiles(),
      catch: (cause) =>
        new WorkspaceSearchIndexService.WorkspaceSearchIndexRefreshFailed({
          cwd,
          reason: "FileFinder.scanFiles threw unexpectedly.",
          cause,
        }),
    });
    if (!result.ok) {
      return yield* new WorkspaceSearchIndexService.WorkspaceSearchIndexRefreshFailed({
        cwd,
        reason: result.error,
      });
    }
    yield* waitForIndexReady(
      cwd,
      finder,
      ({ reason, cause }) =>
        new WorkspaceSearchIndexService.WorkspaceSearchIndexRefreshFailed({
          cwd,
          reason,
          cause,
        }),
    );
  });

  const list: WorkspaceSearchIndexService.WorkspaceSearchIndex["Service"]["list"] = Effect.fn(
    "WorkspaceSearchIndex.list",
  )(function* () {
    const result = yield* runSearch(
      "",
      WorkspaceSearchIndexService.WORKSPACE_INDEX_PAGE_SIZE,
      "mixedSearch",
      () =>
        finder.mixedSearch("", { pageSize: WorkspaceSearchIndexService.WORKSPACE_INDEX_PAGE_SIZE }),
    );
    const mapped = mapMixedSearchResult(
      result,
      WorkspaceSearchIndexService.WORKSPACE_INDEX_MAX_ENTRIES,
      platform,
    );
    const sortedEntries = withDirectoryAncestors(mapped.entries).toSorted((left, right) =>
      left.path.localeCompare(right.path),
    );
    const entries = sortedEntries.slice(0, WorkspaceSearchIndexService.WORKSPACE_INDEX_MAX_ENTRIES);
    return {
      entries,
      truncated: mapped.truncated || entries.length < sortedEntries.length,
    };
  });

  const search: WorkspaceSearchIndexService.WorkspaceSearchIndex["Service"]["search"] = Effect.fn(
    "WorkspaceSearchIndex.search",
  )(function* (query, limit, kind, imageOnly) {
    const pageSize = imageOnly
      ? WorkspaceSearchIndexService.WORKSPACE_INDEX_PAGE_SIZE
      : Math.max(1, limit + 1);
    if (kind === "file" || imageOnly) {
      const result = yield* runSearch(query, pageSize, "fileSearch", () =>
        finder.fileSearch(query, { pageSize }),
      );
      return mapFileSearchResult(result, limit, platform, imageOnly);
    }
    if (kind === "directory") {
      const result = yield* runSearch(query, pageSize, "directorySearch", () =>
        finder.directorySearch(query, { pageSize }),
      );
      return mapDirectorySearchResult(result, limit, platform);
    }
    const result = yield* runSearch(query, pageSize, "mixedSearch", () =>
      finder.mixedSearch(query, { pageSize }),
    );
    return mapMixedSearchResult(result, limit, platform);
  });

  const searchContents: WorkspaceSearchIndexService.WorkspaceSearchIndex["Service"]["searchContents"] =
    Effect.fn("WorkspaceSearchIndex.searchContents")(function* (input) {
      const { searchQuery, regexMode } = buildContentSearchQuery(input);
      const deadline = performance.now() + CONTENT_SEARCH_TIME_BUDGET_MS;
      // Grep cursors advance by file, so whole-word post-filtering needs enough
      // raw candidates from the current file before moving to the next one.
      let rawPageSize = input.wholeWord
        ? Math.max(input.limit, CONTENT_SEARCH_MAX_MATCHES_PER_FILE)
        : input.limit;
      const matches: Array<ProjectSearchContentsResult["matches"][number]> = [];
      let nextCursor: GrepCursor | null = null;
      let regexFallbackError: string | undefined;
      let candidateLimitReached = false;

      while (true) {
        const remainingTimeBudgetMs = Math.max(1, Math.ceil(deadline - performance.now()));
        const result = yield* runSearch(input.query, input.limit, "grep", () =>
          finder.grep(searchQuery, {
            mode: regexMode ? "regex" : "plain",
            smartCase: !input.caseSensitive && !regexMode,
            // Whole-word filtering needs the full candidate page from a dense file.
            maxMatchesPerFile: input.wholeWord
              ? rawPageSize
              : Math.min(CONTENT_SEARCH_MAX_MATCHES_PER_FILE, rawPageSize),
            pageSize: rawPageSize,
            cursor: nextCursor,
            timeBudgetMs: remainingTimeBudgetMs,
          }),
        );

        regexFallbackError ??= result.regexFallbackError;
        const pageMatches: Array<ProjectSearchContentsResult["matches"][number]> = [];
        for (const match of result.items) {
          const matchRanges = mapContentMatchRanges(match.lineContent, match.matchRanges).filter(
            (range) => !input.wholeWord || isWholeWordRange(match.lineContent, range),
          );
          if (matchRanges.length === 0) continue;
          pageMatches.push({
            path: toPosixPath(match.relativePath, platform),
            lineNumber: match.lineNumber,
            lineContent: match.lineContent,
            matchRanges,
          });
        }
        // Cursors advance by file. Retry a full raw page before skipping a file
        // whose later lines may contain the first whole-word match.
        if (input.wholeWord && result.items.length >= rawPageSize) {
          if (
            matches.length + pageMatches.length < input.limit &&
            rawPageSize < CONTENT_SEARCH_MAX_CANDIDATES &&
            performance.now() < deadline
          ) {
            rawPageSize = Math.min(CONTENT_SEARCH_MAX_CANDIDATES, rawPageSize * 2);
            continue;
          }
          candidateLimitReached = true;
        }
        matches.push(...pageMatches);
        nextCursor = result.nextCursor;
        if (
          candidateLimitReached ||
          matches.length >= input.limit ||
          nextCursor === null ||
          performance.now() >= deadline
        ) {
          break;
        }
      }

      return {
        matches: matches.slice(0, input.limit),
        truncated: candidateLimitReached || matches.length > input.limit || nextCursor !== null,
        ...(regexFallbackError !== undefined ? { regexFallbackError } : {}),
      };
    });

  return WorkspaceSearchIndexService.WorkspaceSearchIndex.of({
    list,
    refresh,
    search,
    searchContents,
  });
});
