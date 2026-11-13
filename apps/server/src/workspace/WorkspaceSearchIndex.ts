// @effect-diagnostics nodeBuiltinImport:off - readdir with file types avoids an lstat per child
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";

import type {
  DirItem,
  FileItem,
  FileFinder as FileFinderType,
  GrepCursor,
  MixedItem,
  Result,
  WatchEvent,
  WatchUnsubscribe,
} from "@ff-labs/fff-node";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as LayerMap from "effect/LayerMap";
import * as Option from "effect/Option";
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
import * as HostProcess from "@t3tools/shared/HostProcess";
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
// A scan no watcher can invalidate is reused this long, so typing does not rescan every folder.
const UNWATCHED_SYMLINK_SCAN_TTL_MS = 2_000;
// A rescan that outlasts this leaves the read on the previous scan.
const SYMLINK_RESCAN_WAIT = "5 millis";
// Each page is a synchronous native call; small pages let searches run between them.
const SYMLINK_DIRECTORY_PAGE_SIZE = 1_000;

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

// Only the host separator becomes `/`: on POSIX `\` is a file name character.
function toPosixPath(input: string, hostIsWindows: boolean): string {
  return hostIsWindows ? input.replaceAll("\\", "/") : input;
}

function trimDirectorySeparator(input: string): string {
  return input.endsWith("/") ? input.slice(0, -1) : input;
}

function parentPathOf(input: string): string | undefined {
  const separatorIndex = input.lastIndexOf("/");
  return separatorIndex === -1 ? undefined : input.slice(0, separatorIndex);
}

function toProjectEntry(item: MixedItem, hostIsWindows: boolean): ProjectEntry | null {
  const normalizedPath = trimDirectorySeparator(toPosixPath(item.item.relativePath, hostIsWindows));
  if (!normalizedPath) {
    return null;
  }

  return {
    path: normalizedPath,
    kind: item.type,
  };
}

function toFileEntry(item: FileItem, hostIsWindows: boolean): ProjectEntry | null {
  const normalizedPath = trimDirectorySeparator(toPosixPath(item.relativePath, hostIsWindows));
  return normalizedPath ? { path: normalizedPath, kind: "file" } : null;
}

function toDirectoryEntry(item: DirItem, hostIsWindows: boolean): ProjectEntry | null {
  const normalizedPath = trimDirectorySeparator(toPosixPath(item.relativePath, hostIsWindows));
  return normalizedPath ? { path: normalizedPath, kind: "directory" } : null;
}

type SearchPage<I> = { readonly items: ReadonlyArray<I>; readonly totalMatched: number };

function mapFileSearchResult(
  result: SearchPage<FileItem>,
  limit: number,
  hostIsWindows: boolean,
  imageOnly = false,
): ProjectSearchEntriesResult {
  const entries = result.items.flatMap((item) => {
    const entry = toFileEntry(item, hostIsWindows);
    return entry && (!imageOnly || isProjectFaviconPath(entry.path)) ? [entry] : [];
  });
  return {
    entries: entries.slice(0, limit),
    truncated: entries.length > limit || result.totalMatched > result.items.length,
  };
}

function mapDirectorySearchResult(
  result: SearchPage<DirItem>,
  limit: number,
  hostIsWindows: boolean,
): ProjectSearchEntriesResult {
  const entries = result.items.flatMap((item) => {
    const entry = toDirectoryEntry(item, hostIsWindows);
    return entry ? [entry] : [];
  });
  const rootDirectoryCount = result.items.some((item) => item.relativePath.length === 0) ? 1 : 0;
  return {
    entries: entries.slice(0, limit),
    truncated: result.totalMatched - rootDirectoryCount > limit,
  };
}

function mapMixedSearchResult(
  result: SearchPage<MixedItem>,
  limit: number,
  hostIsWindows: boolean,
): { readonly entries: ProjectEntry[]; readonly truncated: boolean } {
  const entries: ProjectEntry[] = [];
  for (const item of result.items) {
    const entry = toProjectEntry(item, hostIsWindows);
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
  /** Every symlink in the folder, including ones dropped for leaving the workspace. */
  readonly linkPaths: ReadonlyArray<string>;
  /** A nested repository (or the workspace's own), whose ignore rules own what is below it. */
  readonly isRepository: boolean;
  readonly ignoreFile: string | undefined;
}

const joinEntryPath = (directory: string, name: string) =>
  directory ? `${directory}/${name}` : name;

/**
 * fff skips symlinks, and `followSymlinks` drops file links, dedupes folder links, and walks out
 * of the workspace. So links are read from the folders fff already indexed (ignore rules applied),
 * without descending into them, and kept only when they resolve inside the workspace.
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
  const linkPaths: string[] = [];
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
    linkPaths.push(entryPath);
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
  return { directory, links, linkPaths, isRepository, ignoreFile } satisfies ScannedDirectory;
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
  linkPaths: ReadonlySet<string>,
  symlinks: ReadonlyArray<ProjectEntry>,
  query: string,
  limit: number,
): ProjectSearchEntriesResult {
  if (linkPaths.size === 0) return indexed;
  // fff's watcher indexes links created after its scan, under a kind of its own choosing, so a
  // path it already returned takes the link's kind (or drops out of a kind-filtered search).
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
    const entry = linkPaths.has(indexedEntry.path)
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

// fff applies .gitignore files only; Git also ignores paths from .git/info/exclude and the global excludes file.
const listGitIgnoredPaths = Effect.fn("WorkspaceSearchIndex.listGitIgnoredPaths")(function* (
  vcsProcess: VcsProcess.VcsProcess["Service"],
  cwd: string,
  hostIsWindows: boolean,
) {
  const result = yield* vcsProcess
    .run({
      operation: "WorkspaceSearchIndex.listGitIgnoredPaths",
      command: "git",
      args: [
        "-c",
        "core.fsmonitor=false",
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
        "-z",
      ],
      cwd,
      allowNonZeroExit: true,
      timeoutMs: 10_000,
      maxOutputBytes: 16 * 1024 * 1024,
    })
    .pipe(Effect.orElseSucceed(() => undefined));
  if (!result || result.exitCode !== 0 || result.stdoutTruncated) return new Set<string>();
  return new Set(
    result.stdout
      .split("\0")
      .filter((entry) => entry.length > 0)
      .map((entry) => trimDirectorySeparator(toPosixPath(entry, hostIsWindows))),
  );
});

function mixedItemPath(item: MixedItem): string {
  return item.item.relativePath;
}

function isIgnoredPath(
  ignoredPaths: ReadonlySet<string>,
  relativePath: string,
  hostIsWindows: boolean,
): boolean {
  if (ignoredPaths.size === 0) return false;
  let candidate: string | undefined = trimDirectorySeparator(
    toPosixPath(relativePath, hostIsWindows),
  );
  while (candidate) {
    if (ignoredPaths.has(candidate)) return true;
    candidate = parentPathOf(candidate);
  }
  return false;
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
  const hostIsWindows = yield* HostProcess.isWindows;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const finder = yield* Effect.acquireRelease(createFinder(cwd, variant), (finder) =>
    Effect.try({
      try: () => finder.destroy(),
      catch: (cause) => new WorkspaceSearchIndexDestroyFailed({ cwd, cause }),
    }).pipe(Effect.orDie),
  );
  let initialScanTimedOut = false;
  const vcsProcess = yield* VcsProcess.VcsProcess;
  let ignoredPaths = yield* listGitIgnoredPaths(vcsProcess, cwd, hostIsWindows);
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

  // fff's isScanning takes the picker lock too, so progress is read off the JS thread.
  const isScanning = Effect.promise(async () => {
    try {
      const progress = await finder.getScanProgressAsync();
      return !progress.ok || progress.value.isScanning;
    } catch {
      return true;
    }
  });
  const hasIncompleteInitialScan = () => (initialScanTimedOut ? isScanning : Effect.succeed(false));

  const runSearch = Effect.fn("WorkspaceSearchIndex.runSearch")(function* <A>(
    query: string,
    pageSize: number,
    operation: "directorySearch" | "fileSearch" | "grep" | "mixedSearch",
    execute: () => Promise<Result<A>>,
  ): Effect.fn.Return<A, WorkspaceSearchIndexSearchFailed> {
    // fff's searches wait on its picker lock, which its watcher can hold for minutes.
    const result = yield* Effect.tryPromise({
      try: execute,
      catch: (cause) =>
        new WorkspaceSearchIndexSearchFailed({
          cwd,
          queryLength: query.length,
          pageSize,
          reason: `FileFinder.${operation} rejected unexpectedly.`,
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

  const root = yield* fileSystem.realPath(cwd).pipe(Effect.orElseSucceed(() => cwd));

  const listIndexedDirectories = Effect.fn("WorkspaceSearchIndex.listIndexedDirectories")(
    function* () {
      const directories: string[] = [];
      // fff's pageIndex is an offset into the results, not a page number.
      for (let pageIndex = 0; ; pageIndex += SYMLINK_DIRECTORY_PAGE_SIZE) {
        const result = yield* Effect.promise(async () => {
          try {
            return await finder.directorySearchAsync("", {
              pageIndex,
              pageSize: SYMLINK_DIRECTORY_PAGE_SIZE,
            });
          } catch {
            return undefined;
          }
        });
        if (!result?.ok) return directories;
        for (const item of result.value.items) {
          const directory = trimDirectorySeparator(toPosixPath(item.relativePath, hostIsWindows));
          if (directory) directories.push(directory);
        }
        if (result.value.items.length < SYMLINK_DIRECTORY_PAGE_SIZE) return directories;
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
    if (result?.exitCode !== 0 || result.stdoutTruncated) {
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
    const indexComplete = !(yield* isScanning);
    const directories = yield* listIndexedDirectories();
    const scanned = yield* Effect.forEach(
      ["", ...directories],
      (directory) => scanDirectory(fileSystem, path, cwd, root, directory),
      { concurrency: SYMLINK_SCAN_CONCURRENCY },
    );
    const candidates = scanned.flatMap((directory) => directory.links);
    const linkPaths = new Set(scanned.flatMap((directory) => directory.linkPaths));
    if (candidates.length === 0) return { entries: candidates, linkPaths, indexComplete };

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
      linkPaths,
      indexComplete,
    };
  });

  // One scan runs at a time and outlives the reads that started it. Only the first read waits for
  // it in full: after that a change or expiry marks the result stale, and reads wait briefly for
  // the rescan before answering from the last finished one, so file churn cannot stall search.
  type SymlinkScan = Effect.Success<ReturnType<typeof scanSymlinkEntries>>;
  let lastSymlinkScan: SymlinkScan | undefined;
  let lastSymlinkScanExpiresAt: number | undefined;
  let pendingSymlinkScan: Deferred.Deferred<SymlinkScan> | undefined;
  let symlinkScanStale = false;
  let knownLinkPaths: ReadonlySet<string> = new Set();
  const invalidateSymlinkScan = () => {
    symlinkScanStale = true;
  };
  const isKnownLink = (absolutePath: string) =>
    [cwd, root].some((base) =>
      knownLinkPaths.has(toPosixPath(path.relative(base, absolutePath), hostIsWindows)),
    );
  const onWatchBatch = (events: ReadonlyArray<WatchEvent>) => {
    // fff reports a link replaced in place as `modified`, so edits to known links count too.
    const editsOnly = events.every(
      (event) =>
        event.kind === "modified" &&
        !/(^|[\\/])\.(git)?ignore$/.test(event.path) &&
        !isKnownLink(event.path),
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
  const indexScope = yield* Effect.scope;
  const startSymlinkScan = Effect.fn("WorkspaceSearchIndex.startSymlinkScan")(function* () {
    symlinkScanStale = false;
    // Subscribing before the scan starts means no change during it goes unseen.
    const watched = ensureWatching();
    const done = yield* Deferred.make<SymlinkScan>();
    pendingSymlinkScan = done;
    yield* scanSymlinkEntries().pipe(
      Effect.tap((result) =>
        Effect.gen(function* () {
          lastSymlinkScan = result;
          knownLinkPaths = result.linkPaths;
          // Without a watcher, or before fff has seen every folder, the result is kept only briefly.
          lastSymlinkScanExpiresAt =
            watched && result.indexComplete
              ? undefined
              : (yield* Clock.currentTimeMillis) + UNWATCHED_SYMLINK_SCAN_TTL_MS;
        }),
      ),
      Effect.onExit((exit) =>
        Effect.sync(() => {
          pendingSymlinkScan = undefined;
        }).pipe(Effect.andThen(Deferred.done(done, exit))),
      ),
      Effect.forkIn(indexScope),
    );
    return done;
  });
  const listSymlinkEntries = Effect.fn("WorkspaceSearchIndex.listSymlinkEntries")(function* () {
    if (
      lastSymlinkScanExpiresAt !== undefined &&
      (yield* Clock.currentTimeMillis) >= lastSymlinkScanExpiresAt
    ) {
      symlinkScanStale = true;
    }
    const pending =
      pendingSymlinkScan ??
      (lastSymlinkScan === undefined || symlinkScanStale ? yield* startSymlinkScan() : undefined);
    let result = lastSymlinkScan;
    if (pending && result === undefined) {
      result = yield* Deferred.await(pending);
    } else if (pending) {
      const fresh = yield* Deferred.await(pending).pipe(Effect.timeoutOption(SYMLINK_RESCAN_WAIT));
      if (Option.isSome(fresh)) result = fresh.value;
    }
    if (result === undefined)
      return yield* Effect.die("The symlink scan finished without a result.");
    return {
      // Git's ignore rules hide a link the same way searchVisible hides the files it indexes.
      entries: result.entries.filter(
        (entry) => !isIgnoredPath(ignoredPaths, entry.path, hostIsWindows),
      ),
      linkPaths: result.linkPaths,
    };
  });

  // Grows the first page until hidden entries can no longer crowd visible ones out of it.
  const searchVisible = Effect.fn("WorkspaceSearchIndex.searchVisible")(function* <I>(
    query: string,
    pageSize: number,
    operation: "directorySearch" | "fileSearch" | "mixedSearch",
    execute: (pageSize: number) => Promise<Result<SearchPage<I>>>,
    pathOf: (item: I) => string,
  ): Effect.fn.Return<SearchPage<I>, WorkspaceSearchIndexSearchFailed> {
    let size = pageSize;
    while (true) {
      const fetchSize = size;
      const result = yield* runSearch(query, fetchSize, operation, () => execute(fetchSize));
      if (ignoredPaths.size === 0) return result;
      const items = result.items.filter(
        (item) => !isIgnoredPath(ignoredPaths, pathOf(item), hostIsWindows),
      );
      if (
        items.length >= pageSize ||
        result.items.length >= result.totalMatched ||
        fetchSize >= WORKSPACE_INDEX_PAGE_SIZE
      ) {
        return {
          items,
          totalMatched: result.totalMatched - (result.items.length - items.length),
        };
      }
      size = Math.min(WORKSPACE_INDEX_PAGE_SIZE, fetchSize * 4);
    }
  });

  const refresh: WorkspaceSearchIndex["Service"]["refresh"] = Effect.fn(
    "WorkspaceSearchIndex.refresh",
  )(function* () {
    // scanFiles waits on fff's picker lock, which its watcher can hold for seconds.
    const result = yield* Effect.tryPromise({
      try: () => finder.scanFilesAsync(),
      catch: (cause) =>
        new WorkspaceSearchIndexRefreshFailed({
          cwd,
          reason: "FileFinder.scanFilesAsync rejected unexpectedly.",
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
    ignoredPaths = yield* listGitIgnoredPaths(vcsProcess, cwd, hostIsWindows);
    invalidateSymlinkScan();
  });

  const list: WorkspaceSearchIndex["Service"]["list"] = Effect.fn("WorkspaceSearchIndex.list")(
    function* () {
      const incompleteBeforeQuery = yield* hasIncompleteInitialScan();
      const result = yield* searchVisible(
        "",
        WORKSPACE_INDEX_PAGE_SIZE,
        "mixedSearch",
        (pageSize) => finder.mixedSearchAsync("", { pageSize }),
        mixedItemPath,
      );
      const mapped = mapMixedSearchResult(result, WORKSPACE_INDEX_MAX_ENTRIES, hostIsWindows);
      const symlinks = yield* listSymlinkEntries();
      // fff's watcher can index a link the scan rejected; only accepted links are listed.
      const indexed = mapped.entries.filter((entry) => !symlinks.linkPaths.has(entry.path));
      const sortedEntries = withDirectoryAncestors([...indexed, ...symlinks.entries]).toSorted(
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

  const searchNames = Effect.fn("WorkspaceSearchIndex.searchNames")(function* (
    query: string,
    limit: number,
    kind: ProjectEntryKind | undefined,
    imageOnly: boolean | undefined,
  ) {
    const { entries: allSymlinks, linkPaths } = yield* listSymlinkEntries();
    const symlinks = allSymlinks.filter((entry) =>
      imageOnly
        ? entry.kind === "file" && isProjectFaviconPath(entry.path)
        : kind === undefined || entry.kind === kind,
    );
    // Index results that are filtered-out links get dropped in the merge, so fetch past them.
    const indexLimit = limit + linkPaths.size - symlinks.length;
    const pageSize = imageOnly ? WORKSPACE_INDEX_PAGE_SIZE : Math.max(1, indexLimit + 1);
    const merge = (indexed: ProjectSearchEntriesResult) =>
      mergeSymlinkMatches(indexed, linkPaths, symlinks, query, limit);
    if (kind === "file" || imageOnly) {
      const result = yield* searchVisible(
        query,
        pageSize,
        "fileSearch",
        (size) => finder.fileSearchAsync(query, { pageSize: size }),
        (item) => item.relativePath,
      );
      return merge(mapFileSearchResult(result, indexLimit, hostIsWindows, imageOnly));
    }
    if (kind === "directory") {
      const result = yield* searchVisible(
        query,
        pageSize,
        "directorySearch",
        (size) => finder.directorySearchAsync(query, { pageSize: size }),
        (item) => item.relativePath,
      );
      return merge(mapDirectorySearchResult(result, indexLimit, hostIsWindows));
    }
    const result = yield* searchVisible(
      query,
      pageSize,
      "mixedSearch",
      (size) => finder.mixedSearchAsync(query, { pageSize: size }),
      mixedItemPath,
    );
    return merge(mapMixedSearchResult(result, indexLimit, hostIsWindows));
  });

  const search: WorkspaceSearchIndex["Service"]["search"] = Effect.fn(
    "WorkspaceSearchIndex.search",
  )(function* (rawQuery, limit, kind, imageOnly) {
    // fff parses any word containing "[" or "{" as a glob and has no escape for them; fuzzy
    // matching is subsequence-based, so dropping them still matches "[id]" and "a{b}" paths.
    // "{" is dropped only when the query finds nothing as a glob, so "*.{ts,tsx}" keeps working.
    const query = rawQuery.replaceAll("[", "");
    const incompleteBeforeQuery = yield* hasIncompleteInitialScan();
    let mapped = yield* searchNames(query, limit, kind, imageOnly);
    if (mapped.entries.length === 0 && query.includes("{")) {
      mapped = yield* searchNames(query.replaceAll("{", ""), limit, kind, imageOnly);
    }
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
        finder.grepAsync(searchQuery, {
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
        if (isIgnoredPath(ignoredPaths, match.relativePath, hostIsWindows)) continue;
        const matchRanges = mapContentMatchRanges(match.lineContent, match.matchRanges).filter(
          (range) => !input.wholeWord || isWholeWordRange(match.lineContent, range),
        );
        // fff reports hits past its 512-char lineContent cap with no ranges, so whole words can't be verified there.
        if (input.wholeWord && matchRanges.length === 0) continue;
        matches.push({
          path: toPosixPath(match.relativePath, hostIsWindows),
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
