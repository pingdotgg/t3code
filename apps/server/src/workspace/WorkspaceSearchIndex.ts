// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
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
  WatchEvent,
  WatchUnsubscribe,
} from "@ff-labs/fff-node";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as LayerMap from "effect/LayerMap";
import * as Path from "effect/Path";
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
import { scoreSubsequenceMatch } from "@t3tools/shared/searchRanking";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import { type IgnoreDecision, type IgnoreFile, parseIgnoreFile } from "./IgnorePatterns.ts";

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
const SYMLINK_SCAN_CONCURRENCY = 16;

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
    readonly refresh: () => Effect.Effect<
      void,
      WorkspaceSearchIndexRefreshFailed | WorkspaceSearchIndexScanTimedOut
    >;
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

interface ScannedDirectory {
  readonly directory: string;
  readonly links: ReadonlyArray<ProjectEntry>;
  /** A nested repository (or the workspace's own), whose ignore rules own what is below it. */
  readonly isRepository: boolean;
  readonly ignoreFile: string | undefined;
}

const joinEntryPath = (directory: string, name: string) =>
  directory ? `${directory}/${name}` : name;

/**
 * fff skips symlinks, and its `followSymlinks` is no substitute: it still drops file links,
 * dedupes directory links against their targets, and walks links out of the workspace and into
 * ignored folders. So the links themselves are found by reading the folders fff already indexed
 * (which ignore rules have filtered), without descending into them, and kept only when they
 * resolve inside the workspace.
 */
const scanDirectory = Effect.fn("WorkspaceSearchIndex.scanDirectory")(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  cwd: string,
  root: string,
  directory: string,
) {
  // Effect's readDirectory returns bare names; one lstat per child would cost far more.
  const children = yield* Effect.promise(() =>
    NodeFSP.readdir(path.join(cwd, directory), { withFileTypes: true }).catch(() => []),
  );
  const links: ProjectEntry[] = [];
  let isRepository = false;
  let ignoreFile: string | undefined;
  for (const child of children) {
    if (child.name === ".git") isRepository = true;
    if (child.name === ".ignore" && child.isFile()) {
      ignoreFile = yield* fileSystem
        .readFileString(path.join(cwd, directory, child.name))
        .pipe(Effect.orElseSucceed(() => undefined));
    }
    if (!child.isSymbolicLink()) continue;
    const entryPath = joinEntryPath(directory, child.name);
    const absolutePath = path.join(cwd, entryPath);
    const target = yield* Effect.all([
      fileSystem.realPath(absolutePath),
      fileSystem.stat(absolutePath),
    ]).pipe(Effect.orElseSucceed(() => undefined));
    if (!target) continue;
    const relative = path.relative(root, target[0]);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative) ||
      relative.split(path.sep).includes(".git") ||
      (target[1].type !== "Directory" && target[1].type !== "File")
    ) {
      continue;
    }
    links.push({ path: entryPath, kind: target[1].type === "Directory" ? "directory" : "file" });
  }
  return { directory, links, isRepository, ignoreFile } satisfies ScannedDirectory;
});

/** Whether `entryPath` is `directory` itself or below it. */
const isWithin = (entryPath: string, directory: string) =>
  directory === "" || entryPath.startsWith(`${directory}/`);

/**
 * fff reads `.ignore` files alongside git's rules, and like ripgrep the nearest one that matches
 * decides, ahead of any `.gitignore`. `ignoreFiles` is ordered deepest folder first.
 */
function decideByIgnoreFiles(
  entry: ProjectEntry,
  ignoreFiles: ReadonlyArray<{ readonly directory: string; readonly file: IgnoreFile }>,
): IgnoreDecision | undefined {
  for (const { directory, file } of ignoreFiles) {
    if (!isWithin(entry.path, directory) || entry.path === directory) continue;
    const relative = directory ? entry.path.slice(directory.length + 1) : entry.path;
    // Like git and ripgrep, a link is never a folder to a folder-only rule, whatever it targets.
    const decision = file.decide(relative, false);
    if (decision) return decision;
  }
  return undefined;
}

/** Places each symlink before the first index result that matches the query less closely. */
function mergeSymlinkMatches(
  indexed: ProjectSearchEntriesResult,
  allSymlinks: ReadonlyArray<ProjectEntry>,
  symlinks: ReadonlyArray<ProjectEntry>,
  query: string,
  limit: number,
): ProjectSearchEntriesResult {
  if (allSymlinks.length === 0) return indexed;
  // fff's watcher indexes links created after its scan, under a kind of its own choosing, so a
  // path it already returned takes the link's kind (or drops out of a kind-filtered search).
  const allSymlinkPaths = new Set(allSymlinks.map((entry) => entry.path));
  const symlinkByPath = new Map(symlinks.map((entry) => [entry.path, entry]));
  const score = (entry: ProjectEntry) =>
    scoreSubsequenceMatch(entry.path.toLowerCase(), query) ?? Number.POSITIVE_INFINITY;
  const indexedPaths = new Set(indexed.entries.map((entry) => entry.path));
  const pending = symlinks
    .flatMap((entry) => {
      const entryScore = score(entry);
      return Number.isFinite(entryScore) && !indexedPaths.has(entry.path)
        ? [{ entry, score: entryScore }]
        : [];
    })
    .toSorted((left, right) => left.score - right.score);
  const entries: ProjectEntry[] = [];
  let nextPending = 0;
  for (const indexedEntry of indexed.entries) {
    const entry = allSymlinkPaths.has(indexedEntry.path)
      ? symlinkByPath.get(indexedEntry.path)
      : indexedEntry;
    if (!entry) continue;
    const entryScore = score(entry);
    while (nextPending < pending.length && pending[nextPending]!.score < entryScore) {
      entries.push(pending[nextPending++]!.entry);
    }
    entries.push(entry);
  }
  for (; nextPending < pending.length; nextPending += 1) entries.push(pending[nextPending]!.entry);
  return {
    entries: entries.slice(0, limit),
    truncated: indexed.truncated || entries.length > limit,
  };
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
        enableFsRootScanning: true,
        enableHomeDirScanning: true,
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
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
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

  const listIndexedDirectories = Effect.fn("WorkspaceSearchIndex.listIndexedDirectories")(
    function* () {
      const directories: string[] = [];
      // fff's pageIndex is an offset into the results, not a page number.
      for (let pageIndex = 0; ; pageIndex += WORKSPACE_INDEX_PAGE_SIZE) {
        const result = yield* Effect.try(() =>
          finder.directorySearch("", { pageIndex, pageSize: WORKSPACE_INDEX_PAGE_SIZE }),
        ).pipe(Effect.orElseSucceed(() => undefined));
        if (!result?.ok) return directories;
        for (const item of result.value.items) {
          const directory = trimDirectorySeparator(toPosixPath(item.relativePath));
          if (directory) directories.push(directory);
        }
        if (result.value.items.length < WORKSPACE_INDEX_PAGE_SIZE) return directories;
        yield* Effect.yieldNow;
      }
    },
  );

  /** Ignore rules belong to the repository that owns a path, so each one answers for its own. */
  const listGitIgnored = Effect.fn("WorkspaceSearchIndex.listGitIgnored")(function* (
    repository: string,
    entries: ReadonlyArray<ProjectEntry>,
  ) {
    const relativePaths = entries.map((entry) =>
      repository ? entry.path.slice(repository.length + 1) : entry.path,
    );
    const repositoryCwd = path.join(cwd, repository);
    const result = yield* vcsProcess
      .run({
        operation: "WorkspaceSearchIndex.listGitIgnored",
        command: "git",
        // fff applies ignore rules to tracked paths too, so the index is not consulted.
        args: ["-c", "core.fsmonitor=false", "check-ignore", "--no-index", "-z", "--stdin"],
        cwd: repositoryCwd,
        stdin: `${relativePaths.join("\0")}\0`,
        allowNonZeroExit: true,
        timeoutMs: 10_000,
        maxOutputBytes: 16 * 1024 * 1024,
      })
      .pipe(Effect.orElseSucceed(() => undefined));
    // Exit 1 means nothing matched.
    if (result?.exitCode === 1) return [];
    if (result?.exitCode !== 0) {
      // Outside git no rules apply (git exits before reading stdin, so the cause is lost).
      // Any other failure hides the repository's links rather than leaking ones it ignores.
      const insideRepository = yield* vcsProcess
        .run({
          operation: "WorkspaceSearchIndex.listGitIgnored",
          command: "git",
          args: ["rev-parse", "--git-dir"],
          cwd: repositoryCwd,
          timeoutMs: 10_000,
        })
        .pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
      return insideRepository ? entries.map((entry) => entry.path) : [];
    }
    return result.stdout
      .split("\0")
      .filter(Boolean)
      .map((relativePath) => (repository ? `${repository}/${relativePath}` : relativePath));
  });

  const scanSymlinkEntries = Effect.fn("WorkspaceSearchIndex.scanSymlinkEntries")(function* () {
    const indexComplete = !finder.isScanning();
    const root = yield* fileSystem.realPath(cwd).pipe(Effect.orElseSucceed(() => cwd));
    const directories = yield* listIndexedDirectories();
    const scanned = yield* Effect.forEach(
      ["", ...directories],
      (directory) => scanDirectory(fileSystem, path, cwd, root, directory),
      { concurrency: SYMLINK_SCAN_CONCURRENCY },
    );
    const candidates = scanned.flatMap((directory) => directory.links);
    if (candidates.length === 0) return { entries: candidates, indexComplete };

    const ignoreFiles = scanned
      .flatMap(({ directory, ignoreFile }) =>
        ignoreFile === undefined ? [] : [{ directory, file: parseIgnoreFile(ignoreFile) }],
      )
      .toSorted((left, right) => right.directory.length - left.directory.length);
    const decisions = new Map(
      candidates.map((entry) => [entry.path, decideByIgnoreFiles(entry, ignoreFiles)]),
    );
    const repositories = [
      "",
      ...scanned.flatMap(({ directory, isRepository }) =>
        isRepository && directory ? [directory] : [],
      ),
    ].toSorted((left, right) => right.length - left.length);
    const entriesByRepository = Map.groupBy(
      candidates.filter((entry) => decisions.get(entry.path) === undefined),
      (entry) =>
        repositories.find(
          (repository) => isWithin(entry.path, repository) && entry.path !== repository,
        ) ?? "",
    );
    const ignored = new Set(
      (yield* Effect.forEach(
        entriesByRepository,
        ([repository, entries]) => listGitIgnored(repository, entries),
        { concurrency: 4 },
      )).flat(),
    );
    return {
      entries: candidates.filter((entry) =>
        decisions.get(entry.path) === undefined
          ? !ignored.has(entry.path)
          : decisions.get(entry.path) === "included",
      ),
      indexComplete,
    };
  });

  // Concurrent callers share one scan, and it stops once all of them are interrupted. The
  // watcher reports link changes too, so a batch that could move a link or an ignore rule drops
  // the scan; a scan still in flight then only answers the callers already waiting on it.
  let symlinkScan:
    | {
        readonly scan: Effect.Effect<Effect.Success<ReturnType<typeof scanSymlinkEntries>>>;
        readonly watched: boolean;
      }
    | undefined;
  const invalidateSymlinkScan = () => {
    symlinkScan = undefined;
  };
  const onWatchBatch = (events: ReadonlyArray<WatchEvent>) => {
    const editsOnly = events.every(
      (event) => event.kind === "modified" && !/(^|[\\/])\.(git)?ignore$/.test(event.path),
    );
    if (!editsOnly) invalidateSymlinkScan();
  };
  // fff refuses subscriptions until its watcher is up, which can trail the initial scan, so
  // each read retries until one is in place.
  let unwatch: WatchUnsubscribe | undefined;
  yield* Effect.addFinalizer(() => Effect.sync(() => unwatch?.()));
  const ensureWatching = () => {
    if (unwatch) return true;
    try {
      const result = finder.watch(onWatchBatch);
      if (result.ok) unwatch = result.value;
    } catch {
      // Not ready yet; the next read tries again.
    }
    return unwatch !== undefined;
  };
  const listSymlinkEntries = Effect.fn("WorkspaceSearchIndex.listSymlinkEntries")(function* () {
    // Subscribing before the scan starts means no change during it goes unseen.
    const current = symlinkScan ?? {
      watched: ensureWatching(),
      scan: yield* Effect.cachedWithTTL(scanSymlinkEntries(), Duration.infinity),
    };
    symlinkScan = current;
    const result = yield* current.scan;
    // Without a watcher, or before fff has seen every folder, the result cannot be kept.
    if ((!current.watched || !result.indexComplete) && symlinkScan === current) {
      invalidateSymlinkScan();
    }
    return result.entries;
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
    yield* waitForIndexReady(
      cwd,
      finder,
      ({ reason, cause }) =>
        new WorkspaceSearchIndexRefreshFailed({
          cwd,
          reason,
          cause,
        }),
    );
    invalidateSymlinkScan();
  });

  const list: WorkspaceSearchIndex["Service"]["list"] = Effect.fn("WorkspaceSearchIndex.list")(
    function* () {
      const incompleteBeforeQuery = hasIncompleteInitialScan();
      const result = yield* runSearch("", WORKSPACE_INDEX_PAGE_SIZE, "mixedSearch", () =>
        finder.mixedSearch("", { pageSize: WORKSPACE_INDEX_PAGE_SIZE }),
      );
      const mapped = mapMixedSearchResult(result, WORKSPACE_INDEX_MAX_ENTRIES);
      const symlinks = yield* listSymlinkEntries();
      const sortedEntries = withDirectoryAncestors([...mapped.entries, ...symlinks]).toSorted(
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
  )(function* (query, limit, kind, imageOnly) {
    const pageSize = imageOnly ? WORKSPACE_INDEX_PAGE_SIZE : Math.max(1, limit + 1);
    const incompleteBeforeQuery = hasIncompleteInitialScan();
    const allSymlinks = yield* listSymlinkEntries();
    const symlinks = allSymlinks.filter((entry) =>
      imageOnly
        ? entry.kind === "file" && isProjectFaviconPath(entry.path)
        : kind === undefined || entry.kind === kind,
    );
    if (kind === "file" || imageOnly) {
      const result = yield* runSearch(query, pageSize, "fileSearch", () =>
        finder.fileSearch(query, { pageSize }),
      );
      const mapped = mapFileSearchResult(result, limit, imageOnly);
      return mergeSymlinkMatches(
        { ...mapped, truncated: incompleteBeforeQuery || mapped.truncated },
        allSymlinks,
        symlinks,
        query,
        limit,
      );
    }
    if (kind === "directory") {
      const result = yield* runSearch(query, pageSize, "directorySearch", () =>
        finder.directorySearch(query, { pageSize }),
      );
      const mapped = mapDirectorySearchResult(result, limit);
      return mergeSymlinkMatches(
        { ...mapped, truncated: incompleteBeforeQuery || mapped.truncated },
        allSymlinks,
        symlinks,
        query,
        limit,
      );
    }
    const result = yield* runSearch(query, pageSize, "mixedSearch", () =>
      finder.mixedSearch(query, { pageSize }),
    );
    const mapped = mapMixedSearchResult(result, limit);
    return mergeSymlinkMatches(
      { ...mapped, truncated: incompleteBeforeQuery || mapped.truncated },
      allSymlinks,
      symlinks,
      query,
      limit,
    );
  });

  const searchContents: WorkspaceSearchIndex["Service"]["searchContents"] = Effect.fn(
    "WorkspaceSearchIndex.searchContents",
  )(function* (input) {
    const { searchQuery, regexMode } = buildContentSearchQuery(input);
    const deadline = performance.now() + CONTENT_SEARCH_TIME_BUDGET_MS;
    // Grep cursors advance per file; whole-word filtering needs enough raw candidates before advancing.
    const rawPageSize = input.wholeWord
      ? Math.max(input.limit, CONTENT_SEARCH_MAX_MATCHES_PER_FILE)
      : input.limit;
    const matches: Array<ProjectSearchContentsResult["matches"][number]> = [];
    let nextCursor: GrepCursor | null = null;
    let regexFallbackError: string | undefined;

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

      for (const match of result.items) {
        const matchRanges = mapContentMatchRanges(match.lineContent, match.matchRanges).filter(
          (range) => !input.wholeWord || isWholeWordRange(match.lineContent, range),
        );
        if (matchRanges.length === 0) continue;
        matches.push({
          path: toPosixPath(match.relativePath),
          lineNumber: match.lineNumber,
          lineContent: match.lineContent,
          matchRanges,
        });
      }
      nextCursor = result.nextCursor;
      regexFallbackError ??= result.regexFallbackError;
    } while (matches.length < input.limit && nextCursor !== null && performance.now() < deadline);

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
