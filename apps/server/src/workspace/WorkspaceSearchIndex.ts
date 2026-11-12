// @effect-diagnostics nodeBuiltinImport:off - finding symlinks needs readdir file types, which FileSystem lacks.
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

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
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as LayerMap from "effect/LayerMap";
import * as Schema from "effect/Schema";

import type {
  ProjectEntry,
  ProjectEntryKind,
  ProjectListEntriesResult,
  ProjectSearchContentsInput,
  ProjectSearchContentsResult,
  ProjectSearchEntriesResult,
} from "@t3tools/contracts";
import { isProjectFaviconPath } from "@t3tools/shared/projectFavicon";
import ignore, { type Ignore } from "ignore";

import * as VcsProcess from "../vcs/VcsProcess.ts";

// fff-node's native library stays external; single-executables require disk packages instead of importing them.
const requireForFff = NodeModule.createRequire(import.meta.url);
const { FileFinder } = requireForFff("@ff-labs/fff-node") as typeof import("@ff-labs/fff-node");

const WORKSPACE_INDEX_MAX_ENTRIES = 25_000;
const WORKSPACE_INDEX_PAGE_SIZE = WORKSPACE_INDEX_MAX_ENTRIES + 2;
const WORKSPACE_INDEX_SCAN_TIMEOUT = "15 seconds";
const WORKSPACE_INDEX_SCAN_TIMEOUT_MS = 15_000;
const WORKSPACE_INDEX_IDLE_TTL = "15 minutes";
const CONTENT_SEARCH_TIME_BUDGET_MS = 250;
const CONTENT_SEARCH_MAX_MATCHES_PER_FILE = 100;
const SYMLINK_SCAN_BATCH_SIZE = 64;

export class WorkspaceSearchIndexCreateFailed extends Schema.TaggedError<WorkspaceSearchIndexCreateFailed>()(
  "WorkspaceSearchIndexCreateFailed",
  {
    cwd: Schema.String,
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to create the workspace search index for '${this.cwd}'.`;
  }
}

export class WorkspaceSearchIndexScanTimedOut extends Schema.TaggedError<WorkspaceSearchIndexScanTimedOut>()(
  "WorkspaceSearchIndexScanTimedOut",
  {
    cwd: Schema.String,
    timeout: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace search index for '${this.cwd}' did not finish scanning within ${this.timeout}`;
  }
}

export class WorkspaceSearchIndexSearchFailed extends Schema.TaggedError<WorkspaceSearchIndexSearchFailed>()(
  "WorkspaceSearchIndexSearchFailed",
  {
    cwd: Schema.String,
    queryLength: Schema.Number,
    pageSize: Schema.Number,
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Workspace search failed for '${this.cwd}'.`;
  }
}

export class WorkspaceSearchIndexRefreshFailed extends Schema.TaggedError<WorkspaceSearchIndexRefreshFailed>()(
  "WorkspaceSearchIndexRefreshFailed",
  {
    cwd: Schema.String,
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to refresh the workspace search index for '${this.cwd}'.`;
  }
}

export class WorkspaceSearchIndexDestroyFailed extends Schema.TaggedError<WorkspaceSearchIndexDestroyFailed>()(
  "WorkspaceSearchIndexDestroyFailed",
  {
    cwd: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to destroy the workspace search index for '${this.cwd}'.`;
  }
}

export class WorkspaceSearchIndex extends Context.Service<
  WorkspaceSearchIndex,
  {
    readonly list: () => Effect.Effect<ProjectListEntriesResult, WorkspaceSearchIndexSearchFailed>;
    readonly search: (
      query: string,
      limit: number,
      kind?: ProjectEntryKind,
      imageOnly?: boolean,
    ) => Effect.Effect<ProjectSearchEntriesResult, WorkspaceSearchIndexSearchFailed>;
    readonly searchContents: (
      input: Omit<ProjectSearchContentsInput, "cwd">,
    ) => Effect.Effect<ProjectSearchContentsResult, WorkspaceSearchIndexSearchFailed>;
    readonly refresh: () => Effect.Effect<void, WorkspaceSearchIndexRefreshFailed>;
  }
>()("t3/workspace/WorkspaceSearchIndex") {}

function toPosixPath(input: string): string {
  return input.replaceAll("\\", "/");
}

function trimDirectorySeparator(input: string): string {
  return input.endsWith("/") ? input.slice(0, -1) : input;
}

function parentPathOf(input: string): string | undefined {
  const separatorIndex = input.lastIndexOf("/");
  return separatorIndex === -1 ? undefined : input.slice(0, separatorIndex);
}

function toProjectEntry(item: MixedItem): ProjectEntry | null {
  const normalizedPath = trimDirectorySeparator(toPosixPath(item.item.relativePath));
  if (!normalizedPath) {
    return null;
  }

  return {
    path: normalizedPath,
    kind: item.type,
  };
}

function toFileEntry(item: FileItem): ProjectEntry | null {
  const normalizedPath = trimDirectorySeparator(toPosixPath(item.relativePath));
  return normalizedPath ? { path: normalizedPath, kind: "file" } : null;
}

function toDirectoryEntry(item: DirItem): ProjectEntry | null {
  const normalizedPath = trimDirectorySeparator(toPosixPath(item.relativePath));
  return normalizedPath ? { path: normalizedPath, kind: "directory" } : null;
}

function mapFileSearchResult(
  result: SearchResult,
  limit: number,
  imageOnly = false,
): ProjectSearchEntriesResult {
  const entries = result.items.flatMap((item) => {
    const entry = toFileEntry(item);
    return entry && (!imageOnly || isProjectFaviconPath(entry.path)) ? [entry] : [];
  });
  return {
    entries: entries.slice(0, limit),
    truncated: entries.length > limit || result.totalMatched > result.items.length,
  };
}

function mapDirectorySearchResult(
  result: DirSearchResult,
  limit: number,
): ProjectSearchEntriesResult {
  const entries = result.items.flatMap((item) => {
    const entry = toDirectoryEntry(item);
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
): { readonly entries: ProjectEntry[]; readonly truncated: boolean } {
  const entries: ProjectEntry[] = [];
  for (const item of result.items) {
    const entry = toProjectEntry(item);
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

// Post-filter whole words: consuming boundary regexes swallow adjacent separators and widen ranges; \b misses punctuation edges.
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

async function resolveSymlinkKind(root: string, absolutePath: string) {
  const target = await NodeFSP.realpath(absolutePath).catch(() => undefined);
  if (target === undefined) return undefined;
  const relative = NodePath.relative(root, target);
  if (
    relative === ".." ||
    relative.startsWith(`..${NodePath.sep}`) ||
    NodePath.isAbsolute(relative) ||
    relative.split(NodePath.sep).includes(".git")
  ) {
    return undefined;
  }
  const stat = await NodeFSP.stat(target).catch(() => undefined);
  if (stat?.isFile()) return "file";
  return stat?.isDirectory() ? "directory" : undefined;
}

// fff leaves symlinks out of its index; list them beside it, without following directory links.
async function scanSymlinkEntries(
  cwd: string,
  directories: ReadonlyArray<string>,
): Promise<ProjectEntry[]> {
  const root = await NodeFSP.realpath(cwd).catch(() => undefined);
  if (root === undefined) return [];
  const entries: ProjectEntry[] = [];
  for (
    let offset = 0;
    offset < directories.length && entries.length < WORKSPACE_INDEX_MAX_ENTRIES;
    offset += SYMLINK_SCAN_BATCH_SIZE
  ) {
    const batch = await Promise.all(
      directories.slice(offset, offset + SYMLINK_SCAN_BATCH_SIZE).map(async (directory) => {
        const children = await NodeFSP.readdir(NodePath.join(cwd, directory), {
          withFileTypes: true,
        }).catch(() => []);
        return Promise.all(
          children.map(async (child): Promise<ProjectEntry[]> => {
            if (!child.isSymbolicLink() || child.name === ".git") return [];
            const entryPath = directory ? `${directory}/${child.name}` : child.name;
            const kind = await resolveSymlinkKind(root, NodePath.join(cwd, entryPath));
            return kind ? [{ path: entryPath, kind }] : [];
          }),
        );
      }),
    );
    entries.push(...batch.flat(2));
  }
  return entries.slice(0, WORKSPACE_INDEX_MAX_ENTRIES);
}

// fff applies .ignore over .gitignore, deeper folders first, and hides dotfiles outside git; git check-ignore sees neither .ignore nor non-git folders.
async function withoutIgnoredSymlinks(
  cwd: string,
  links: ReadonlyArray<ProjectEntry>,
  insideGit: boolean,
): Promise<ProjectEntry[]> {
  const rulesByFile = new Map<string, Promise<Ignore | undefined>>();
  const rulesFor = (file: string) => {
    let rules = rulesByFile.get(file);
    if (rules === undefined) {
      rules = NodeFSP.readFile(NodePath.join(cwd, file), "utf8").then(
        (contents) => ignore({ ignorecase: false }).add(contents),
        () => undefined,
      );
      rulesByFile.set(file, rules);
    }
    return rules;
  };
  const isIgnored = async (link: ProjectEntry) => {
    const segments = link.path.split("/");
    if (!insideGit && segments.at(-1)?.startsWith(".")) return true;
    for (let depth = segments.length - 1; depth >= 0; depth -= 1) {
      const directory = segments.slice(0, depth).join("/");
      const relative = `${segments.slice(depth).join("/")}${link.kind === "directory" ? "/" : ""}`;
      for (const name of [".ignore", ".gitignore"]) {
        const result = (await rulesFor(directory ? `${directory}/${name}` : name))?.test(relative);
        if (result?.ignored) return true;
        if (result?.unignored) return false;
      }
    }
    return false;
  };
  const ignored = await Promise.all(links.map(isIgnored));
  return links.filter((_, index) => !ignored[index]);
}

// fff's watcher reports no event when a symlink is deleted, so cached links are re-checked on each read.
async function currentSymlinkEntries(
  cwd: string,
  links: ReadonlyArray<ProjectEntry>,
): Promise<ProjectEntry[]> {
  const root = await NodeFSP.realpath(cwd).catch(() => undefined);
  if (root === undefined) return [];
  const kinds = await Promise.all(
    links.map((link) => resolveSymlinkKind(root, NodePath.join(cwd, link.path))),
  );
  return links.flatMap((link, index) => {
    const kind = kinds[index];
    return kind ? [{ path: link.path, kind }] : [];
  });
}

function withSymlinkMatches(
  result: ProjectSearchEntriesResult,
  links: ReadonlyArray<ProjectEntry>,
  query: string,
  limit: number,
): ProjectSearchEntriesResult {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = links.filter((link) =>
    tokens.every((token) => link.path.toLowerCase().includes(token)),
  );
  if (matches.length === 0) return result;
  // Links named by the query rank first; links matched only through their folders rank last.
  const byName = (link: ProjectEntry) =>
    tokens.length > 0 &&
    tokens.every((token) =>
      link.path
        .slice(link.path.lastIndexOf("/") + 1)
        .toLowerCase()
        .includes(token),
    );
  const entries = [
    ...matches.filter(byName),
    ...result.entries,
    ...matches.filter((link) => !byName(link)),
  ];
  return {
    entries: entries.slice(0, limit),
    truncated: result.truncated || entries.length > limit,
  };
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
  variant: WorkspaceSearchIndexVariant,
) {
  const result = yield* Effect.try({
    try: () =>
      FileFinder.create({
        basePath: cwd,
        disableMmapCache: true,
        // Content indexing costs CPU/memory; path-only consumers use the lightweight index.
        disableContentIndexing: variant !== "content",
        aiMode: false,
      }),
    catch: (cause) =>
      new WorkspaceSearchIndexCreateFailed({
        cwd,
        reason: "FileFinder.create threw unexpectedly.",
        cause,
      }),
  });
  if (result.ok) return result.value;
  return yield* new WorkspaceSearchIndexCreateFailed({
    cwd,
    reason: result.error,
  });
});

const waitForIndexReady = Effect.fn("WorkspaceSearchIndex.waitForIndexReady")(function* <E>(
  cwd: string,
  finder: FileFinderType,
  onFailure: (input: { readonly reason: string; readonly cause?: unknown }) => E,
): Effect.fn.Return<void, E | WorkspaceSearchIndexScanTimedOut> {
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
    return yield* new WorkspaceSearchIndexScanTimedOut({
      cwd,
      timeout: WORKSPACE_INDEX_SCAN_TIMEOUT,
    });
  }
});

export const make = Effect.fn("WorkspaceSearchIndex.make")(function* (
  cwd: string,
  variant: WorkspaceSearchIndexVariant = "paths",
) {
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const finder = yield* Effect.acquireRelease(createFinder(cwd, variant), (finder) =>
    Effect.try({
      try: () => finder.destroy(),
      catch: (cause) => new WorkspaceSearchIndexDestroyFailed({ cwd, cause }),
    }).pipe(Effect.orDie),
  );
  let initialScanTimedOut = false;
  yield* waitForIndexReady(
    cwd,
    finder,
    ({ reason, cause }) =>
      new WorkspaceSearchIndexCreateFailed({
        cwd,
        reason,
        cause,
      }),
  ).pipe(
    Effect.catchTags({
      WorkspaceSearchIndexScanTimedOut: (error) =>
        variant === "paths"
          ? Effect.sync(() => {
              initialScanTimedOut = true;
            })
          : Effect.fail(error),
    }),
  );

  const hasIncompleteInitialScan = () => initialScanTimedOut && finder.isScanning();

  const runSearch = Effect.fn("WorkspaceSearchIndex.runSearch")(function* <A>(
    query: string,
    pageSize: number,
    operation: "directorySearch" | "fileSearch" | "grep" | "mixedSearch",
    execute: () => Result<A>,
  ): Effect.fn.Return<A, WorkspaceSearchIndexSearchFailed> {
    const result = yield* Effect.try({
      try: execute,
      catch: (cause) =>
        new WorkspaceSearchIndexSearchFailed({
          cwd,
          queryLength: query.length,
          pageSize,
          reason: `FileFinder.${operation} threw unexpectedly.`,
          cause,
        }),
    });
    if (!result.ok) {
      return yield* new WorkspaceSearchIndexSearchFailed({
        cwd,
        queryLength: query.length,
        pageSize,
        reason: result.error,
      });
    }
    return result.value;
  });

  const scanSymlinks = Effect.fn("WorkspaceSearchIndex.scanSymlinks")(function* () {
    const directories = yield* runSearch("", WORKSPACE_INDEX_PAGE_SIZE, "directorySearch", () =>
      finder.directorySearch("", { pageSize: WORKSPACE_INDEX_PAGE_SIZE }),
    );
    const links = yield* Effect.promise(() =>
      // directorySearch omits the workspace root.
      scanSymlinkEntries(cwd, [
        ...new Set([
          "",
          ...directories.items.map((item) =>
            trimDirectorySeparator(toPosixPath(item.relativePath)),
          ),
        ]),
      ]),
    );
    if (links.length === 0) return links;
    // Covers global git excludes; outside a git repository this check fails.
    const result = yield* vcsProcess
      .run({
        operation: "WorkspaceSearchIndex.scanSymlinks",
        command: "git",
        args: ["-c", "core.fsmonitor=false", "check-ignore", "-z", "--stdin"],
        cwd,
        stdin: `${links.map((link) => link.path).join("\0")}\0`,
        allowNonZeroExit: true,
        timeoutMs: 10_000,
        maxOutputBytes: 16 * 1024 * 1024,
      })
      .pipe(Effect.orElseSucceed(() => undefined));
    const insideGit = result?.exitCode === 0 || result?.exitCode === 1;
    const gitIgnored = new Set(result?.exitCode === 0 ? result.stdout.split("\0") : []);
    return yield* Effect.promise(() =>
      withoutIgnoredSymlinks(
        cwd,
        links.filter((link) => !gitIgnored.has(link.path)),
        insideGit,
      ),
    );
  });

  let symlinkEntriesCache:
    | Effect.Effect<ReadonlyArray<ProjectEntry>, WorkspaceSearchIndexSearchFailed>
    | undefined;
  const cachedSymlinkEntries = Effect.fn("WorkspaceSearchIndex.cachedSymlinkEntries")(function* () {
    if (symlinkEntriesCache !== undefined) return yield* symlinkEntriesCache;
    const scan = yield* Effect.cached(scanSymlinks());
    if (!hasIncompleteInitialScan()) symlinkEntriesCache = scan;
    return yield* scan.pipe(
      Effect.tapError(() =>
        Effect.sync(() => {
          if (symlinkEntriesCache === scan) symlinkEntriesCache = undefined;
        }),
      ),
    );
  });
  const symlinkEntries = Effect.fn("WorkspaceSearchIndex.symlinkEntries")(function* () {
    const links = yield* cachedSymlinkEntries();
    return links.length === 0
      ? links
      : yield* Effect.promise(() => currentSymlinkEntries(cwd, links));
  });

  const refresh: WorkspaceSearchIndex["Service"]["refresh"] = Effect.fn(
    "WorkspaceSearchIndex.refresh",
  )(function* () {
    const result = yield* Effect.try({
      try: () => finder.scanFiles(),
      catch: (cause) =>
        new WorkspaceSearchIndexRefreshFailed({
          cwd,
          reason: "FileFinder.scanFiles threw unexpectedly.",
          cause,
        }),
    });
    if (!result.ok) {
      return yield* new WorkspaceSearchIndexRefreshFailed({
        cwd,
        reason: result.error,
      });
    }
    // A rescan that outlasts the wait keeps running, and the finder answers
    // from its previous index until it finishes, so the index stays usable.
    yield* waitForIndexReady(
      cwd,
      finder,
      ({ reason, cause }) =>
        new WorkspaceSearchIndexRefreshFailed({
          cwd,
          reason,
          cause,
        }),
    ).pipe(Effect.catchTags({ WorkspaceSearchIndexScanTimedOut: () => Effect.void }));
    symlinkEntriesCache = undefined;
  });

  const list: WorkspaceSearchIndex["Service"]["list"] = Effect.fn("WorkspaceSearchIndex.list")(
    function* () {
      const incompleteBeforeQuery = hasIncompleteInitialScan();
      const result = yield* runSearch("", WORKSPACE_INDEX_PAGE_SIZE, "mixedSearch", () =>
        finder.mixedSearch("", { pageSize: WORKSPACE_INDEX_PAGE_SIZE }),
      );
      const mapped = mapMixedSearchResult(result, WORKSPACE_INDEX_MAX_ENTRIES);
      const links = yield* symlinkEntries();
      const sortedEntries = withDirectoryAncestors([...mapped.entries, ...links]).toSorted(
        (left, right) => left.path.localeCompare(right.path),
      );
      const entries = sortedEntries.slice(0, WORKSPACE_INDEX_MAX_ENTRIES);
      return {
        entries,
        truncated:
          incompleteBeforeQuery || mapped.truncated || entries.length < sortedEntries.length,
      };
    },
  );

  const search: WorkspaceSearchIndex["Service"]["search"] = Effect.fn(
    "WorkspaceSearchIndex.search",
  )(function* (rawQuery, limit, kind, imageOnly) {
    // fff parses any word containing "[" as a glob and has no escape for it; fuzzy
    // matching is subsequence-based, so dropping "[" still matches "[id]" folders.
    const query = rawQuery.replaceAll("[", "");
    const pageSize = imageOnly ? WORKSPACE_INDEX_PAGE_SIZE : Math.max(1, limit + 1);
    const incompleteBeforeQuery = hasIncompleteInitialScan();
    if (kind === "file" || imageOnly) {
      const result = yield* runSearch(query, pageSize, "fileSearch", () =>
        finder.fileSearch(query, { pageSize }),
      );
      const links = (yield* symlinkEntries()).filter(
        (link) => link.kind === "file" && (!imageOnly || isProjectFaviconPath(link.path)),
      );
      const mapped = withSymlinkMatches(
        mapFileSearchResult(result, limit, imageOnly),
        links,
        query,
        limit,
      );
      return { ...mapped, truncated: incompleteBeforeQuery || mapped.truncated };
    }
    if (kind === "directory") {
      const result = yield* runSearch(query, pageSize, "directorySearch", () =>
        finder.directorySearch(query, { pageSize }),
      );
      const links = (yield* symlinkEntries()).filter((link) => link.kind === "directory");
      const mapped = withSymlinkMatches(
        mapDirectorySearchResult(result, limit),
        links,
        query,
        limit,
      );
      return { ...mapped, truncated: incompleteBeforeQuery || mapped.truncated };
    }
    const result = yield* runSearch(query, pageSize, "mixedSearch", () =>
      finder.mixedSearch(query, { pageSize }),
    );
    const mapped = withSymlinkMatches(
      mapMixedSearchResult(result, limit),
      yield* symlinkEntries(),
      query,
      limit,
    );
    return { ...mapped, truncated: incompleteBeforeQuery || mapped.truncated };
  });

  const searchContents: WorkspaceSearchIndex["Service"]["searchContents"] = Effect.fn(
    "WorkspaceSearchIndex.searchContents",
  )(function* (input) {
    let { searchQuery, regexMode } = buildContentSearchQuery(input);
    const deadline = performance.now() + CONTENT_SEARCH_TIME_BUDGET_MS;
    // Grep cursors advance per file; whole-word filtering needs enough raw candidates before advancing.
    const rawPageSize = input.wholeWord
      ? Math.max(input.limit, CONTENT_SEARCH_MAX_MATCHES_PER_FILE)
      : input.limit;
    const matches: Array<ProjectSearchContentsResult["matches"][number]> = [];
    let nextCursor: GrepCursor | null = null;
    let regexFallbackError: string | undefined;
    let retryLiterally = false;

    do {
      const remainingTimeBudgetMs = Math.max(1, Math.ceil(deadline - performance.now()));
      const result = yield* runSearch(input.query, input.limit, "grep", () =>
        finder.grep(searchQuery, {
          mode: regexMode ? "regex" : "plain",
          smartCase: !input.caseSensitive && !regexMode,
          maxMatchesPerFile: Math.min(CONTENT_SEARCH_MAX_MATCHES_PER_FILE, rawPageSize),
          pageSize: rawPageSize,
          cursor: nextCursor,
          timeBudgetMs: remainingTimeBudgetMs,
        }),
      );
      // fff searches an invalid pattern as a literal, which would keep the `(?i)` prefix.
      retryLiterally = regexMode && !input.caseSensitive && result.regexFallbackError !== undefined;
      if (retryLiterally) {
        regexFallbackError = result.regexFallbackError;
        ({ searchQuery, regexMode } = buildContentSearchQuery({ ...input, useRegex: false }));
        continue;
      }

      for (const match of result.items) {
        const matchRanges = mapContentMatchRanges(match.lineContent, match.matchRanges).filter(
          (range) => !input.wholeWord || isWholeWordRange(match.lineContent, range),
        );
        // fff reports hits past its 512-char lineContent cap with no ranges, so whole words can't be verified there.
        if (input.wholeWord && matchRanges.length === 0) continue;
        matches.push({
          path: toPosixPath(match.relativePath),
          lineNumber: match.lineNumber,
          lineContent: match.lineContent,
          matchRanges,
        });
      }
      nextCursor = result.nextCursor;
      regexFallbackError ??= result.regexFallbackError;
    } while (
      retryLiterally ||
      (matches.length < input.limit && nextCursor !== null && performance.now() < deadline)
    );

    return {
      matches: matches.slice(0, input.limit),
      truncated: matches.length > input.limit || nextCursor !== null,
      ...(regexFallbackError !== undefined ? { regexFallbackError } : {}),
    };
  });

  return WorkspaceSearchIndex.of({ list, refresh, search, searchContents });
});

export const WORKSPACE_SEARCH_INDEX_VARIANTS = ["paths", "content"] as const;
export type WorkspaceSearchIndexVariant = (typeof WORKSPACE_SEARCH_INDEX_VARIANTS)[number];

export const workspaceSearchIndexKey = (cwd: string, variant: WorkspaceSearchIndexVariant) =>
  `${variant}\n${cwd}`;

function parseWorkspaceSearchIndexKey(key: string): {
  readonly cwd: string;
  readonly variant: WorkspaceSearchIndexVariant;
} {
  const separatorIndex = key.indexOf("\n");
  return {
    variant: key.slice(0, separatorIndex) as WorkspaceSearchIndexVariant,
    cwd: key.slice(separatorIndex + 1),
  };
}

/** @public */
export const layer = (key: string) => {
  const { cwd, variant } = parseWorkspaceSearchIndexKey(key);
  return Layer.effect(WorkspaceSearchIndex, make(cwd, variant));
};

export class WorkspaceSearchIndexMap extends LayerMap.Service<WorkspaceSearchIndexMap>()(
  "t3/workspace/WorkspaceSearchIndexMap",
  {
    lookup: layer,
    idleTimeToLive: WORKSPACE_INDEX_IDLE_TTL,
  },
) {}
