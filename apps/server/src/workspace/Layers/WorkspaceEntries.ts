import fsPromises from "node:fs/promises";
import type { Dirent } from "node:fs";

import { Cache, Duration, Effect, Exit, Layer, Option, Path } from "effect";

import { type ProjectEntry } from "@t3tools/contracts";
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
  type RankedSearchResult,
} from "@t3tools/shared/searchRanking";

import { GitCore } from "../../git/Services/GitCore.ts";
import {
  WorkspaceEntries,
  WorkspaceEntriesError,
  type WorkspaceEntriesShape,
} from "../Services/WorkspaceEntries.ts";
import { WorkspacePaths } from "../Services/WorkspacePaths.ts";

const WORKSPACE_CACHE_TTL_MS = 15_000;
const WORKSPACE_CACHE_MAX_KEYS = 4;
const WORKSPACE_INDEX_MAX_ENTRIES = 25_000;
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
  truncated: boolean;
}

interface SearchableWorkspaceEntry extends ProjectEntry {
  normalizedPath: string;
  normalizedName: string;
}

type RankedWorkspaceEntry = RankedSearchResult<SearchableWorkspaceEntry>;

function toPosixPath(input: string): string {
  return input.replaceAll("\\", "/");
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
      fuzzyBase: 100,
    }),
    scoreQueryMatch({
      value: normalizedPath,
      query,
      exactBase: 1,
      prefixBase: 3,
      boundaryBase: 4,
      includesBase: 6,
      fuzzyBase: 200,
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

export const makeWorkspaceEntries = Effect.gen(function* () {
  const path = yield* Path.Path;
  const gitOption = yield* Effect.serviceOption(GitCore);
  const workspacePaths = yield* WorkspacePaths;

  const isInsideGitWorkTree = (cwd: string): Effect.Effect<boolean> =>
    Option.match(gitOption, {
      onSome: (git) => git.isInsideWorkTree(cwd).pipe(Effect.catch(() => Effect.succeed(false))),
      onNone: () => Effect.succeed(false),
    });

  const filterGitIgnoredPaths = (
    cwd: string,
    relativePaths: string[],
  ): Effect.Effect<string[], never> =>
    Option.match(gitOption, {
      onSome: (git) =>
        git.filterIgnoredPaths(cwd, relativePaths).pipe(
          Effect.map((paths) => [...paths]),
          Effect.catch(() => Effect.succeed(relativePaths)),
        ),
      onNone: () => Effect.succeed(relativePaths),
    });

  const buildWorkspaceIndexFromGit = Effect.fn("WorkspaceEntries.buildWorkspaceIndexFromGit")(
    function* (cwd: string) {
      if (Option.isNone(gitOption)) {
        return null;
      }
      if (!(yield* isInsideGitWorkTree(cwd))) {
        return null;
      }

      const listedFiles = yield* gitOption.value
        .listWorkspaceFiles(cwd)
        .pipe(Effect.catch(() => Effect.succeed(null)));

      if (!listedFiles) {
        return null;
      }

      const listedPaths = [...listedFiles.paths]
        .map((entry) => toPosixPath(entry))
        .filter((entry) => entry.length > 0 && !isPathInIgnoredDirectory(entry));
      const filePaths = yield* filterGitIgnoredPaths(cwd, listedPaths);

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

      const entries = [...directoryEntries, ...fileEntries];
      return {
        scannedAt: Date.now(),
        entries: entries.slice(0, WORKSPACE_INDEX_MAX_ENTRIES),
        truncated: listedFiles.truncated || entries.length > WORKSPACE_INDEX_MAX_ENTRIES,
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
  )(function* (cwd: string): Effect.fn.Return<WorkspaceIndex, WorkspaceEntriesError> {
    const shouldFilterWithGitIgnore = yield* isInsideGitWorkTree(cwd);

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
        ? new Set(yield* filterGitIgnoredPaths(cwd, candidatePaths))
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

          if (entries.length >= WORKSPACE_INDEX_MAX_ENTRIES) {
            truncated = true;
            break;
          }
        }

        if (truncated) {
          break;
        }
      }
    }

    return {
      scannedAt: Date.now(),
      entries,
      truncated,
    };
  });

  const buildWorkspaceIndex = Effect.fn("WorkspaceEntries.buildWorkspaceIndex")(function* (
    cwd: string,
  ): Effect.fn.Return<WorkspaceIndex, WorkspaceEntriesError> {
    const gitIndexed = yield* buildWorkspaceIndexFromGit(cwd);
    if (gitIndexed) {
      return gitIndexed;
    }
    return yield* buildWorkspaceIndexFromFilesystem(cwd);
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
      yield* Cache.invalidate(workspaceIndexCache, cwd);
      if (normalizedCwd !== cwd) {
        yield* Cache.invalidate(workspaceIndexCache, normalizedCwd);
      }
    },
  );

  const search: WorkspaceEntriesShape["search"] = Effect.fn("WorkspaceEntries.search")(
    function* (input) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
      return yield* Cache.get(workspaceIndexCache, normalizedCwd).pipe(
        Effect.map((index) => {
          const normalizedQuery = normalizeSearchQuery(input.query, {
            trimLeadingPattern: /^[@./]+/,
          });
          const limit = Math.max(0, Math.floor(input.limit));
          const rankedEntries: RankedWorkspaceEntry[] = [];
          let matchedEntryCount = 0;

          for (const entry of index.entries) {
            const score = scoreEntry(entry, normalizedQuery);
            if (score === null) {
              continue;
            }

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
          };
        }),
      );
    },
  );

  return {
    invalidate,
    search,
  } satisfies WorkspaceEntriesShape;
});

export const WorkspaceEntriesLive = Layer.effect(WorkspaceEntries, makeWorkspaceEntries);
