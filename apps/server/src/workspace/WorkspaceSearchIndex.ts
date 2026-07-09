// @effect-diagnostics nodeBuiltinImport:off
import type * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { FileFinder, MixedItem, MixedSearchResult } from "@ff-labs/fff-node";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as LayerMap from "effect/LayerMap";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import type {
  ProjectEntry,
  ProjectListEntriesResult,
  ProjectSearchEntriesResult,
} from "@t3tools/contracts";

const WORKSPACE_INDEX_MAX_ENTRIES = 25_000;
const WORKSPACE_INDEX_PAGE_SIZE = WORKSPACE_INDEX_MAX_ENTRIES + 2;
const WORKSPACE_INDEX_SCAN_TIMEOUT = "15 seconds";
const WORKSPACE_INDEX_IDLE_TTL = "15 minutes";
const WORKSPACE_INDEX_SCAN_POLL_INTERVAL = "50 millis";
const FALLBACK_EXCLUDED_DIRECTORIES = new Set([".git", ".convex", "node_modules"]);

export class WorkspaceSearchIndexCreateFailed extends Schema.TaggedErrorClass<WorkspaceSearchIndexCreateFailed>()(
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

export class WorkspaceSearchIndexScanTimedOut extends Schema.TaggedErrorClass<WorkspaceSearchIndexScanTimedOut>()(
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

export class WorkspaceSearchIndexSearchFailed extends Schema.TaggedErrorClass<WorkspaceSearchIndexSearchFailed>()(
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

export class WorkspaceSearchIndexRefreshFailed extends Schema.TaggedErrorClass<WorkspaceSearchIndexRefreshFailed>()(
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

export class WorkspaceSearchIndexDestroyFailed extends Schema.TaggedErrorClass<WorkspaceSearchIndexDestroyFailed>()(
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

export type WorkspaceSearchIndexError =
  | WorkspaceSearchIndexCreateFailed
  | WorkspaceSearchIndexScanTimedOut
  | WorkspaceSearchIndexSearchFailed
  | WorkspaceSearchIndexRefreshFailed;

type FileFinderModule = Pick<typeof import("@ff-labs/fff-node"), "FileFinder">;
type FileFinderModuleLoader = () => Promise<FileFinderModule>;

const loadFileFinderModule: FileFinderModuleLoader = () => import("@ff-labs/fff-node");

export class WorkspaceSearchIndex extends Context.Service<
  WorkspaceSearchIndex,
  {
    readonly list: () => Effect.Effect<ProjectListEntriesResult, WorkspaceSearchIndexSearchFailed>;
    readonly search: (
      query: string,
      limit: number,
    ) => Effect.Effect<ProjectSearchEntriesResult, WorkspaceSearchIndexSearchFailed>;
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

function isFuzzySubsequence(query: string, candidate: string): boolean {
  let queryIndex = 0;
  for (const char of candidate) {
    if (char === query[queryIndex]) {
      queryIndex++;
      if (queryIndex === query.length) return true;
    }
  }
  return query.length === 0;
}

function boundedEditDistance(left: string, right: string, maxDistance: number): number {
  if (Math.abs(left.length - right.length) > maxDistance) return maxDistance + 1;

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    const current = [leftIndex];
    let rowMin = current[0] ?? 0;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      const value = Math.min(
        (previous[rightIndex] ?? 0) + 1,
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) + substitutionCost,
      );
      current[rightIndex] = value;
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > maxDistance) return maxDistance + 1;
    previous = current;
  }
  return previous[right.length] ?? maxDistance + 1;
}

function fallbackSearchScore(entry: ProjectEntry, query: string): number | null {
  if (query.length === 0) return 0;

  const path = entry.path.toLowerCase();
  const basename = NodePath.posix.basename(path);
  if (basename === query) return 0;
  if (basename.startsWith(query)) return 10;
  if (basename.includes(query)) return 20;
  if (path.includes(query)) return 30;
  if (isFuzzySubsequence(query, basename)) return 40;
  if (isFuzzySubsequence(query, path)) return 50;

  const maxTypoDistance = Math.min(2, Math.max(1, Math.floor(query.length / 4)));
  if (boundedEditDistance(query, basename, maxTypoDistance) <= maxTypoDistance) return 60;
  return null;
}

async function buildFallbackEntries(cwd: string): Promise<{
  readonly entries: ProjectEntry[];
  readonly truncated: boolean;
}> {
  const entries: ProjectEntry[] = [];
  const directories = [""];

  for (let index = 0; index < directories.length; index++) {
    const relativeDirectory = directories[index] ?? "";
    const absoluteDirectory = relativeDirectory ? NodePath.join(cwd, relativeDirectory) : cwd;
    let dirents: NodeFS.Dirent[];
    try {
      dirents = await NodeFSP.readdir(absoluteDirectory, { withFileTypes: true });
    } catch (cause) {
      if (relativeDirectory === "") throw cause;
      continue;
    }

    dirents.sort((left, right) => left.name.localeCompare(right.name));
    for (const dirent of dirents) {
      if (dirent.isDirectory() && FALLBACK_EXCLUDED_DIRECTORIES.has(dirent.name)) {
        continue;
      }
      if (!dirent.isDirectory() && !dirent.isFile()) {
        continue;
      }

      const relativePath = toPosixPath(
        relativeDirectory ? NodePath.join(relativeDirectory, dirent.name) : dirent.name,
      );
      entries.push({
        path: relativePath,
        kind: dirent.isDirectory() ? "directory" : "file",
      });
      if (entries.length > WORKSPACE_INDEX_MAX_ENTRIES) {
        return { entries: entries.slice(0, WORKSPACE_INDEX_MAX_ENTRIES), truncated: true };
      }
      if (dirent.isDirectory()) {
        directories.push(relativePath);
      }
    }
  }

  return { entries, truncated: false };
}

const makeFallbackIndex = Effect.fn("WorkspaceSearchIndex.makeFallbackIndex")(function* (
  cwd: string,
  cause: WorkspaceSearchIndexCreateFailed | WorkspaceSearchIndexScanTimedOut,
) {
  yield* Effect.logWarning("Falling back to JS workspace search index", { cwd, cause });
  let fallbackIndex = yield* Effect.tryPromise({
    try: () => buildFallbackEntries(cwd),
    catch: (fallbackCause) =>
      new WorkspaceSearchIndexCreateFailed({
        cwd,
        reason: "Fallback workspace search index creation failed.",
        cause: fallbackCause,
      }),
  });

  const list: WorkspaceSearchIndex["Service"]["list"] = () =>
    Effect.succeed({
      entries: fallbackIndex.entries,
      truncated: fallbackIndex.truncated,
    });

  const search: WorkspaceSearchIndex["Service"]["search"] = (query, limit) =>
    Effect.sync(() => {
      const normalizedQuery = query.toLowerCase();
      const scoredEntries = fallbackIndex.entries
        .map((entry) => ({ entry, score: fallbackSearchScore(entry, normalizedQuery) }))
        .filter(
          (item): item is { readonly entry: ProjectEntry; readonly score: number } =>
            item.score !== null,
        )
        .sort(
          (left, right) =>
            left.score - right.score || left.entry.path.localeCompare(right.entry.path),
        );
      const entries = withDirectoryAncestors(
        scoredEntries.slice(0, limit).map((item) => item.entry),
      );
      return {
        entries,
        truncated: fallbackIndex.truncated || scoredEntries.length > limit,
      };
    });

  const refresh: WorkspaceSearchIndex["Service"]["refresh"] = Effect.fn(
    "WorkspaceSearchIndex.fallbackRefresh",
  )(function* () {
    fallbackIndex = yield* Effect.tryPromise({
      try: () => buildFallbackEntries(cwd),
      catch: (refreshCause) =>
        new WorkspaceSearchIndexRefreshFailed({
          cwd,
          reason: "Fallback workspace search index refresh failed.",
          cause: refreshCause,
        }),
    });
  });

  return WorkspaceSearchIndex.of({ list, refresh, search });
});

const createFinder = Effect.fn("WorkspaceSearchIndex.createFinder")(function* (
  cwd: string,
  loadModule: FileFinderModuleLoader,
) {
  const { FileFinder } = yield* Effect.tryPromise({
    try: loadModule,
    catch: (cause) =>
      new WorkspaceSearchIndexCreateFailed({
        cwd,
        reason: "Failed to load @ff-labs/fff-node native search module.",
        cause,
      }),
  });
  const result = yield* Effect.try({
    try: () =>
      FileFinder.create({
        basePath: cwd,
        disableMmapCache: true,
        disableContentIndexing: true,
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

const waitForScan = <E>(cwd: string, finder: FileFinder, onFailure: (cause: unknown) => E) =>
  Effect.try({
    try: () => finder.isScanning(),
    catch: onFailure,
  }).pipe(
    Effect.repeat({
      while: (scanning) => scanning,
      schedule: Schedule.spaced(WORKSPACE_INDEX_SCAN_POLL_INTERVAL),
    }),
    Effect.timeoutOrElse({
      duration: WORKSPACE_INDEX_SCAN_TIMEOUT,
      orElse: () =>
        new WorkspaceSearchIndexScanTimedOut({ cwd, timeout: WORKSPACE_INDEX_SCAN_TIMEOUT }),
    }),
    Effect.withSpan("WorkspaceSearchIndex.waitForScan"),
  );

const makeNativeIndex = Effect.fn("WorkspaceSearchIndex.makeNativeIndex")(function* (
  cwd: string,
  loadModule: FileFinderModuleLoader,
) {
  const finder = yield* Effect.acquireRelease(createFinder(cwd, loadModule), (finder) =>
    Effect.try({
      try: () => finder.destroy(),
      catch: (cause) => new WorkspaceSearchIndexDestroyFailed({ cwd, cause }),
    }).pipe(Effect.orDie),
  );
  yield* waitForScan(
    cwd,
    finder,
    (cause) =>
      new WorkspaceSearchIndexCreateFailed({
        cwd,
        reason: "FileFinder.isScanning threw while creating the index.",
        cause,
      }),
  );

  const runMixedSearch = Effect.fn("WorkspaceSearchIndex.runMixedSearch")(function* (
    query: string,
    pageSize: number,
  ) {
    const result = yield* Effect.try({
      try: () => finder.mixedSearch(query, { pageSize }),
      catch: (cause) =>
        new WorkspaceSearchIndexSearchFailed({
          cwd,
          queryLength: query.length,
          pageSize,
          reason: "FileFinder.mixedSearch threw unexpectedly.",
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
    yield* waitForScan(
      cwd,
      finder,
      (cause) =>
        new WorkspaceSearchIndexRefreshFailed({
          cwd,
          reason: "FileFinder.isScanning threw while refreshing the index.",
          cause,
        }),
    );
  });

  const list: WorkspaceSearchIndex["Service"]["list"] = Effect.fn("WorkspaceSearchIndex.list")(
    function* () {
      const result = yield* runMixedSearch("", WORKSPACE_INDEX_PAGE_SIZE);
      const mapped = mapMixedSearchResult(result, WORKSPACE_INDEX_MAX_ENTRIES);
      const sortedEntries = withDirectoryAncestors(mapped.entries).toSorted((left, right) =>
        left.path.localeCompare(right.path),
      );
      const entries = sortedEntries.slice(0, WORKSPACE_INDEX_MAX_ENTRIES);
      return {
        entries,
        truncated: mapped.truncated || entries.length < sortedEntries.length,
      };
    },
  );

  const search: WorkspaceSearchIndex["Service"]["search"] = Effect.fn(
    "WorkspaceSearchIndex.search",
  )(function* (query, limit) {
    const result = yield* runMixedSearch(query, Math.max(1, limit + 1));
    return mapMixedSearchResult(result, limit);
  });

  return WorkspaceSearchIndex.of({ list, refresh, search });
});

export const make = Effect.fn("WorkspaceSearchIndex.make")(function* (
  cwd: string,
  loadModule: FileFinderModuleLoader = loadFileFinderModule,
) {
  return yield* makeNativeIndex(cwd, loadModule).pipe(
    Effect.catch((cause) => makeFallbackIndex(cwd, cause)),
  );
});

/**
 * A layer factory is required because every index is scoped to a concrete
 * workspace root. WorkspaceSearchIndexMap owns memoization and idle cleanup;
 * using a default cwd here would mix resources from different workspaces.
 */
export const layer = (cwd: string) => Layer.effect(WorkspaceSearchIndex, make(cwd));

export class WorkspaceSearchIndexMap extends LayerMap.Service<WorkspaceSearchIndexMap>()(
  "t3/workspace/WorkspaceSearchIndexMap",
  {
    lookup: layer,
    idleTimeToLive: WORKSPACE_INDEX_IDLE_TTL,
  },
) {}
