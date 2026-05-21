// @effect-diagnostics nodeBuiltinImport:off
import * as OS from "node:os";
import fsPromises from "node:fs/promises";
import type { Dirent } from "node:fs";

import * as Cache from "effect/Cache";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import {
  type FilesystemBrowseInput,
  type ProjectEntry,
  type ProjectSearchIndexSource,
} from "@t3tools/contracts";
import { isExplicitRelativePath, isWindowsAbsolutePath } from "@t3tools/shared/path";
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
  type RankedSearchResult,
} from "@t3tools/shared/searchRanking";

import { ServerSettingsService } from "../../serverSettings.ts";
import { VcsDriverRegistry } from "../../vcs/VcsDriverRegistry.ts";
import {
  WorkspaceEntries,
  WorkspaceEntriesBrowseError,
  WorkspaceEntriesError,
  type WorkspaceEntriesShape,
} from "../Services/WorkspaceEntries.ts";
import { WorkspacePaths } from "../Services/WorkspacePaths.ts";

const WORKSPACE_CACHE_TTL_MS = 15_000;
const WORKSPACE_CACHE_MAX_KEYS = 4;
const WORKSPACE_INDEX_MAX_ENTRIES = 25_000;
const WORKSPACE_FULL_GIT_OUTPUT_MAX_BYTES = 128 * 1024 * 1024;
const WORKSPACE_SCAN_READDIR_CONCURRENCY = 32;
const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  ".convex",
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "build",
  "out",
  ".cache",
]);

interface WorkspaceIndex {
  scannedAt: number;
  entries: SearchableWorkspaceEntry[];
  grams: Map<string, Uint32Array>;
  entryIdByPath: Map<string, number>;
  pathTree: WorkspacePathNode;
  truncated: boolean;
  source: ProjectSearchIndexSource;
  fullIndexing: boolean;
}

interface SearchableWorkspaceEntry extends ProjectEntry {
  normalizedPath: string;
  normalizedName: string;
}

type RankedWorkspaceEntry = RankedSearchResult<SearchableWorkspaceEntry>;

interface WorkspacePathNode {
  name: string;
  path: string;
  entryId: number | null;
  children: Map<string, WorkspacePathNode>;
}

interface WorkspaceIndexOptions {
  readonly cwd: string;
  readonly fullIndexing: boolean;
}

const workspaceIndexCacheKey = (options: WorkspaceIndexOptions): string =>
  `${options.fullIndexing ? "1" : "0"}\0${options.cwd}`;

const parseWorkspaceIndexCacheKey = (key: string): WorkspaceIndexOptions => ({
  fullIndexing: key.startsWith("1\0"),
  cwd: key.slice(2),
});

const workspaceIndexEntryLimit = (fullIndexing: boolean): number | null =>
  fullIndexing ? null : WORKSPACE_INDEX_MAX_ENTRIES;

const workspaceIndexScanLimit = (entryLimit: number | null): number | null =>
  entryLimit === null ? null : entryLimit + 1;

function toPosixPath(input: string): string {
  return input.replaceAll("\\", "/");
}

function expandHomePath(input: string, path: Path.Path): string {
  if (input === "~") {
    return OS.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(OS.homedir(), input.slice(2));
  }
  return input;
}

function parentPathOf(input: string): string | undefined {
  const separatorIndex = input.lastIndexOf("/");
  if (separatorIndex === -1) {
    return undefined;
  }
  return input.slice(0, separatorIndex);
}

function basenameOf(input: string): string {
  const separatorIndex = input.lastIndexOf("/");
  if (separatorIndex === -1) {
    return input;
  }
  return input.slice(separatorIndex + 1);
}

function toSearchableWorkspaceEntry(entry: ProjectEntry): SearchableWorkspaceEntry {
  const normalizedPath = entry.path.toLowerCase();
  return {
    ...entry,
    normalizedPath,
    normalizedName: basenameOf(normalizedPath),
  };
}

function buildWorkspaceSearchIndex(
  entries: SearchableWorkspaceEntry[],
): Pick<WorkspaceIndex, "entries" | "grams" | "entryIdByPath" | "pathTree"> {
  const entryIdByPath = new Map(entries.map((entry, entryId) => [entry.path, entryId]));

  return {
    entries,
    grams: buildGramIndex(entries),
    entryIdByPath,
    pathTree: buildWorkspacePathTree(entries, entryIdByPath),
  };
}

function addGramsForText(grams: Set<string>, text: string) {
  for (let index = 0; index < text.length; index += 1) {
    const one = text.slice(index, index + 1);
    const two = text.slice(index, index + 2);
    const three = text.slice(index, index + 3);

    if (one.length === 1) grams.add(one);
    if (two.length === 2) grams.add(two);
    if (three.length === 3) grams.add(three);
  }
}

function gramsForEntry(entry: SearchableWorkspaceEntry): string[] {
  const grams = new Set<string>();
  addGramsForText(grams, entry.normalizedName);
  addGramsForText(grams, entry.normalizedPath);
  return [...grams];
}

function gramsForQuery(query: string): string[] {
  if (query.length <= 3) {
    return query ? [query] : [];
  }

  const grams = new Set<string>();
  for (let index = 0; index <= query.length - 3; index += 1) {
    grams.add(query.slice(index, index + 3));
  }
  return [...grams];
}

function buildGramIndex(entries: SearchableWorkspaceEntry[]): Map<string, Uint32Array> {
  const mutableGrams = new Map<string, number[]>();

  for (const [entryId, entry] of entries.entries()) {
    for (const gram of gramsForEntry(entry)) {
      const ids = mutableGrams.get(gram);
      if (ids) {
        ids.push(entryId);
      } else {
        mutableGrams.set(gram, [entryId]);
      }
    }
  }

  return new Map(
    [...mutableGrams].map(([gram, ids]) => [gram, Uint32Array.from(ids.toSorted((a, b) => a - b))]),
  );
}

function makeWorkspacePathNode(
  name: string,
  pathValue: string,
  entryId: number | null,
): WorkspacePathNode {
  return {
    name,
    path: pathValue,
    entryId,
    children: new Map(),
  };
}

function buildWorkspacePathTree(
  entries: SearchableWorkspaceEntry[],
  entryIdByPath: ReadonlyMap<string, number>,
): WorkspacePathNode {
  const root = makeWorkspacePathNode("", "", null);

  for (const entry of entries) {
    const segments = entry.path.split("/");
    let current = root;
    let currentPath = "";

    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const child =
        current.children.get(segment) ??
        makeWorkspacePathNode(segment, currentPath, entryIdByPath.get(currentPath) ?? null);
      current.children.set(segment, child);
      current = child;
    }

    current.entryId = entryIdByPath.get(entry.path) ?? null;
  }

  return root;
}

function intersectSortedEntryIds(left: Uint32Array, right: Uint32Array): Uint32Array {
  const result: number[] = [];
  let leftIndex = 0;
  let rightIndex = 0;

  while (leftIndex < left.length && rightIndex < right.length) {
    const leftId = left[leftIndex];
    const rightId = right[rightIndex];

    if (leftId === undefined || rightId === undefined) {
      break;
    }

    if (leftId === rightId) {
      result.push(leftId);
      leftIndex += 1;
      rightIndex += 1;
    } else if (leftId < rightId) {
      leftIndex += 1;
    } else {
      rightIndex += 1;
    }
  }

  return Uint32Array.from(result);
}

function getCandidateEntryIds(index: WorkspaceIndex, query: string): Uint32Array {
  if (!query) {
    return Uint32Array.from(index.entries.map((_, entryId) => entryId));
  }

  const queryGrams = gramsForQuery(query);
  if (queryGrams.length === 0) {
    return new Uint32Array();
  }

  const postingLists = queryGrams
    .map((gram) => index.grams.get(gram))
    .filter((postingList): postingList is Uint32Array => postingList !== undefined)
    .toSorted((left, right) => left.length - right.length);

  if (postingLists.length !== queryGrams.length) {
    return new Uint32Array();
  }

  const firstPostingList = postingLists[0];
  if (!firstPostingList) {
    return new Uint32Array();
  }

  return postingLists
    .slice(1)
    .reduce(
      (candidateIds, postingList) => intersectSortedEntryIds(candidateIds, postingList),
      firstPostingList,
    );
}

function scoreEntry(entry: SearchableWorkspaceEntry, query: string): number | null {
  if (!query) {
    return entry.kind === "directory" ? 0 : 1;
  }

  const { normalizedPath, normalizedName } = entry;

  const scores = [
    scoreQueryMatch({
      value: normalizedName,
      query,
      exactBase: 0,
      prefixBase: 2,
      includesBase: 5,
    }),
    scoreQueryMatch({
      value: normalizedPath,
      query,
      exactBase: 1,
      prefixBase: 3,
      boundaryBase: 4,
      includesBase: 6,
      boundaryMarkers: ["/"],
    }),
  ].filter((score): score is number => score !== null);

  if (scores.length === 0) {
    return null;
  }

  return Math.min(...scores);
}

function isPathInIgnoredDirectory(relativePath: string): boolean {
  const firstSegment = relativePath.split("/")[0];
  if (!firstSegment) return false;
  return IGNORED_DIRECTORY_NAMES.has(firstSegment);
}

function directoryAncestorsOf(relativePath: string): string[] {
  const segments = relativePath.split("/").filter((segment) => segment.length > 0);
  if (segments.length <= 1) return [];

  const directories: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    directories.push(segments.slice(0, index).join("/"));
  }
  return directories;
}

const resolveBrowseTarget = (
  input: FilesystemBrowseInput,
  pathService: Path.Path,
): Effect.Effect<string, WorkspaceEntriesBrowseError> =>
  Effect.gen(function* () {
    if (process.platform !== "win32" && isWindowsAbsolutePath(input.partialPath)) {
      return yield* new WorkspaceEntriesBrowseError({
        cwd: input.cwd,
        partialPath: input.partialPath,
        operation: "workspaceEntries.resolveBrowseTarget",
        detail: "Windows-style paths are only supported on Windows.",
      });
    }

    if (!isExplicitRelativePath(input.partialPath)) {
      return pathService.resolve(expandHomePath(input.partialPath, pathService));
    }

    if (!input.cwd) {
      return yield* new WorkspaceEntriesBrowseError({
        cwd: input.cwd,
        partialPath: input.partialPath,
        operation: "workspaceEntries.resolveBrowseTarget",
        detail: "Relative filesystem browse paths require a current project.",
      });
    }

    return pathService.resolve(expandHomePath(input.cwd, pathService), input.partialPath);
  });

export const makeWorkspaceEntries = Effect.gen(function* () {
  const path = yield* Path.Path;
  const serverSettingsOption = yield* Effect.serviceOption(ServerSettingsService);
  const vcsRegistry = yield* VcsDriverRegistry;
  const workspacePaths = yield* WorkspacePaths;

  const isInsideVcsWorkTree = (cwd: string): Effect.Effect<boolean> =>
    vcsRegistry.detect({ cwd }).pipe(
      Effect.map((handle) => handle !== null),
      Effect.catch(() => Effect.succeed(false)),
    );

  const filterVcsIgnoredPaths = (
    cwd: string,
    relativePaths: string[],
  ): Effect.Effect<string[], never> =>
    vcsRegistry.detect({ cwd }).pipe(
      Effect.flatMap((handle) =>
        handle
          ? handle.driver.filterIgnoredPaths(cwd, relativePaths).pipe(
              Effect.map((paths) => [...paths]),
              Effect.catch(() => Effect.succeed(relativePaths)),
            )
          : Effect.succeed(relativePaths),
      ),
      Effect.catch(() => Effect.succeed(relativePaths)),
    );

  const buildWorkspaceIndexFromVcs = Effect.fn("WorkspaceEntries.buildWorkspaceIndexFromVcs")(
    function* (input: WorkspaceIndexOptions) {
      const { cwd, fullIndexing } = input;
      const vcs = yield* vcsRegistry.detect({ cwd }).pipe(Effect.catch(() => Effect.succeed(null)));
      if (!vcs) {
        return null;
      }

      const listedFiles = yield* vcs.driver
        .listWorkspaceFiles(
          cwd,
          fullIndexing ? { maxOutputBytes: WORKSPACE_FULL_GIT_OUTPUT_MAX_BYTES } : {},
        )
        .pipe(Effect.catch(() => Effect.succeed(null)));

      if (!listedFiles) {
        return null;
      }

      const listedPaths = [...listedFiles.paths]
        .map((entry) => toPosixPath(entry))
        .filter((entry) => entry.length > 0 && !isPathInIgnoredDirectory(entry));
      const filePaths = yield* vcs.driver.filterIgnoredPaths(cwd, listedPaths).pipe(
        Effect.map((paths) => [...paths]),
        Effect.catch(() => filterVcsIgnoredPaths(cwd, listedPaths)),
      );

      const directorySet = new Set<string>();
      for (const filePath of filePaths) {
        for (const directoryPath of directoryAncestorsOf(filePath)) {
          if (!isPathInIgnoredDirectory(directoryPath)) {
            directorySet.add(directoryPath);
          }
        }
      }

      const directoryEntries = [...directorySet]
        .toSorted((left, right) => left.localeCompare(right))
        .map(
          (directoryPath): ProjectEntry => ({
            path: directoryPath,
            kind: "directory",
            parentPath: parentPathOf(directoryPath),
          }),
        )
        .map(toSearchableWorkspaceEntry);
      const fileEntries = [...new Set(filePaths)]
        .toSorted((left, right) => left.localeCompare(right))
        .map(
          (filePath): ProjectEntry => ({
            path: filePath,
            kind: "file",
            parentPath: parentPathOf(filePath),
          }),
        )
        .map(toSearchableWorkspaceEntry);

      const now = yield* DateTime.now;
      const entries = [...directoryEntries, ...fileEntries];
      const entryLimit = workspaceIndexEntryLimit(fullIndexing);
      const indexedEntries = entryLimit === null ? entries : entries.slice(0, entryLimit);
      return {
        scannedAt: now.epochMilliseconds,
        ...buildWorkspaceSearchIndex(indexedEntries),
        truncated: listedFiles.truncated || (entryLimit !== null && entries.length > entryLimit),
        source: vcs.driver.capabilities.kind,
        fullIndexing,
      };
    },
  );

  const readDirectoryEntries = Effect.fn("WorkspaceEntries.readDirectoryEntries")(function* (
    cwd: string,
    relativeDir: string,
  ): Effect.fn.Return<
    { readonly relativeDir: string; readonly dirents: Dirent[] | null },
    WorkspaceEntriesError
  > {
    return yield* Effect.tryPromise({
      try: async () => {
        const absoluteDir = relativeDir ? path.join(cwd, relativeDir) : cwd;
        const dirents = await fsPromises.readdir(absoluteDir, { withFileTypes: true });
        return { relativeDir, dirents };
      },
      catch: (cause) =>
        new WorkspaceEntriesError({
          cwd,
          operation: "workspaceEntries.readDirectoryEntries",
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    }).pipe(
      Effect.catchIf(
        () => relativeDir.length > 0,
        () => Effect.succeed({ relativeDir, dirents: null }),
      ),
    );
  });

  const buildWorkspaceIndexFromFilesystem = Effect.fn(
    "WorkspaceEntries.buildWorkspaceIndexFromFilesystem",
  )(function* (
    input: WorkspaceIndexOptions,
  ): Effect.fn.Return<WorkspaceIndex, WorkspaceEntriesError> {
    const { cwd, fullIndexing } = input;
    const shouldFilterWithGitIgnore = yield* isInsideVcsWorkTree(cwd);
    const entryLimit = workspaceIndexEntryLimit(fullIndexing);
    const scanLimit = workspaceIndexScanLimit(entryLimit);

    let pendingDirectories: string[] = [""];
    const entries: SearchableWorkspaceEntry[] = [];
    let truncated = false;

    while (pendingDirectories.length > 0 && !truncated) {
      const currentDirectories = pendingDirectories;
      pendingDirectories = [];

      const directoryEntries = yield* Effect.forEach(
        currentDirectories,
        (relativeDir) => readDirectoryEntries(cwd, relativeDir),
        { concurrency: WORKSPACE_SCAN_READDIR_CONCURRENCY },
      );

      const candidateEntriesByDirectory = directoryEntries.map((directoryEntry) => {
        const { relativeDir, dirents } = directoryEntry;
        if (!dirents) return [] as Array<{ dirent: Dirent; relativePath: string }>;

        dirents.sort((left, right) => left.name.localeCompare(right.name));
        const candidates: Array<{ dirent: Dirent; relativePath: string }> = [];
        for (const dirent of dirents) {
          if (!dirent.name || dirent.name === "." || dirent.name === "..") {
            continue;
          }
          if (dirent.isDirectory() && IGNORED_DIRECTORY_NAMES.has(dirent.name)) {
            continue;
          }
          if (!dirent.isDirectory() && !dirent.isFile()) {
            continue;
          }

          const relativePath = toPosixPath(
            relativeDir ? path.join(relativeDir, dirent.name) : dirent.name,
          );
          if (isPathInIgnoredDirectory(relativePath)) {
            continue;
          }
          candidates.push({ dirent, relativePath });
        }
        return candidates;
      });

      const candidatePaths = candidateEntriesByDirectory.flatMap((candidateEntries) =>
        candidateEntries.map((entry) => entry.relativePath),
      );
      const allowedPathSet = shouldFilterWithGitIgnore
        ? new Set(yield* filterVcsIgnoredPaths(cwd, candidatePaths))
        : null;

      for (const candidateEntries of candidateEntriesByDirectory) {
        for (const candidate of candidateEntries) {
          if (allowedPathSet && !allowedPathSet.has(candidate.relativePath)) {
            continue;
          }

          const entry = toSearchableWorkspaceEntry({
            path: candidate.relativePath,
            kind: candidate.dirent.isDirectory() ? "directory" : "file",
            parentPath: parentPathOf(candidate.relativePath),
          });
          entries.push(entry);

          if (candidate.dirent.isDirectory()) {
            pendingDirectories.push(candidate.relativePath);
          }

          if (scanLimit !== null && entries.length >= scanLimit) {
            truncated = true;
            break;
          }
        }

        if (truncated) {
          break;
        }
      }
    }

    const now = yield* DateTime.now;
    const indexedEntries = entryLimit === null ? entries : entries.slice(0, entryLimit);
    return {
      scannedAt: now.epochMilliseconds,
      ...buildWorkspaceSearchIndex(indexedEntries),
      truncated,
      source: "filesystem" as const,
      fullIndexing,
    };
  });

  const buildWorkspaceIndex = Effect.fn("WorkspaceEntries.buildWorkspaceIndex")(function* (
    cacheKey: string,
  ): Effect.fn.Return<WorkspaceIndex, WorkspaceEntriesError> {
    const options = parseWorkspaceIndexCacheKey(cacheKey);
    const startedAt = yield* DateTime.now;
    const index =
      (yield* buildWorkspaceIndexFromVcs(options)) ??
      (yield* buildWorkspaceIndexFromFilesystem(options));
    const endedAt = yield* DateTime.now;
    const durationMs = Math.max(0, endedAt.epochMilliseconds - startedAt.epochMilliseconds);
    yield* Effect.logInfo("workspace search index built", {
      cwd: options.cwd,
      durationMs,
      entries: index.entries.length,
      fullIndexing: index.fullIndexing,
      source: index.source,
      truncated: index.truncated,
    });
    return index;
  });

  const workspaceIndexCache = yield* Cache.makeWith<string, WorkspaceIndex, WorkspaceEntriesError>(
    buildWorkspaceIndex,
    {
      capacity: WORKSPACE_CACHE_MAX_KEYS,
      timeToLive: (exit) =>
        Exit.isSuccess(exit) ? Duration.millis(WORKSPACE_CACHE_TTL_MS) : Duration.zero,
    },
  );

  const normalizeWorkspaceRoot = Effect.fn("WorkspaceEntries.normalizeWorkspaceRoot")(function* (
    cwd: string,
  ): Effect.fn.Return<string, WorkspaceEntriesError> {
    return yield* workspacePaths.normalizeWorkspaceRoot(cwd).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceEntriesError({
            cwd,
            operation: "workspaceEntries.normalizeWorkspaceRoot",
            detail: cause.message,
            cause,
          }),
      ),
    );
  });

  const invalidate: WorkspaceEntriesShape["invalidate"] = Effect.fn("WorkspaceEntries.invalidate")(
    function* (cwd) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(cwd).pipe(
        Effect.catch(() => Effect.succeed(cwd)),
      );
      yield* Cache.invalidate(
        workspaceIndexCache,
        workspaceIndexCacheKey({ cwd, fullIndexing: false }),
      );
      yield* Cache.invalidate(
        workspaceIndexCache,
        workspaceIndexCacheKey({ cwd, fullIndexing: true }),
      );
      if (normalizedCwd !== cwd) {
        yield* Cache.invalidate(
          workspaceIndexCache,
          workspaceIndexCacheKey({ cwd: normalizedCwd, fullIndexing: false }),
        );
        yield* Cache.invalidate(
          workspaceIndexCache,
          workspaceIndexCacheKey({ cwd: normalizedCwd, fullIndexing: true }),
        );
      }
    },
  );

  const browse: WorkspaceEntriesShape["browse"] = Effect.fn("WorkspaceEntries.browse")(
    function* (input) {
      const resolvedInputPath = yield* resolveBrowseTarget(input, path);
      const endsWithSeparator = /[\\/]$/.test(input.partialPath) || input.partialPath === "~";
      const parentPath = endsWithSeparator ? resolvedInputPath : path.dirname(resolvedInputPath);
      const prefix = endsWithSeparator ? "" : path.basename(resolvedInputPath);

      const dirents = yield* Effect.tryPromise({
        try: () => fsPromises.readdir(parentPath, { withFileTypes: true }),
        catch: (cause) =>
          new WorkspaceEntriesBrowseError({
            cwd: input.cwd,
            partialPath: input.partialPath,
            operation: "workspaceEntries.browse.readDirectory",
            detail: `Unable to browse '${parentPath}': ${cause instanceof Error ? cause.message : String(cause)}`,
            cause,
          }),
      });

      const showHidden = endsWithSeparator || prefix.startsWith(".");
      const lowerPrefix = prefix.toLowerCase();

      return {
        parentPath,
        entries: dirents
          .filter(
            (dirent) =>
              dirent.isDirectory() &&
              dirent.name.toLowerCase().startsWith(lowerPrefix) &&
              (showHidden || !dirent.name.startsWith(".")),
          )
          .map((dirent) => ({
            name: dirent.name,
            fullPath: path.join(parentPath, dirent.name),
          }))
          .toSorted((left, right) => left.name.localeCompare(right.name)),
      };
    },
  );

  const search: WorkspaceEntriesShape["search"] = Effect.fn("WorkspaceEntries.search")(
    function* (input) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
      const fullIndexing = yield* Option.match(serverSettingsOption, {
        onSome: (serverSettings) =>
          serverSettings.getSettings.pipe(
            Effect.map((settings) => settings.fullProjectIndexing),
            Effect.catch(() => Effect.succeed(false)),
          ),
        onNone: () => Effect.succeed(false),
      });
      return yield* Cache.get(
        workspaceIndexCache,
        workspaceIndexCacheKey({ cwd: normalizedCwd, fullIndexing }),
      ).pipe(
        Effect.map((index) => {
          const normalizedQuery = normalizeSearchQuery(input.query, {
            trimLeadingPattern: /^[@./]+/,
          });
          const limit = Math.max(0, Math.floor(input.limit));
          const rankedEntries: RankedWorkspaceEntry[] = [];
          let matchedEntryCount = 0;
          const candidateEntryIds = getCandidateEntryIds(index, normalizedQuery);

          for (const entryId of candidateEntryIds) {
            const entry = index.entries[entryId];
            if (!entry) continue;

            const score = scoreEntry(entry, normalizedQuery);
            if (score === null) continue;

            matchedEntryCount += 1;
            insertRankedSearchResult(
              rankedEntries,
              { item: entry, score, tieBreaker: entry.path },
              limit,
            );
          }

          return {
            entries: rankedEntries.map((candidate) => candidate.item),
            truncated: index.truncated || matchedEntryCount > limit,
            index: {
              source: index.source,
              fullIndexing: index.fullIndexing,
              indexedEntryCount: index.entries.length,
              matchedEntryCount,
              indexTruncated: index.truncated,
            },
          };
        }),
      );
    },
  );

  return {
    browse,
    invalidate,
    search,
  } satisfies WorkspaceEntriesShape;
});

export const WorkspaceEntriesLive = Layer.effect(WorkspaceEntries, makeWorkspaceEntries);
