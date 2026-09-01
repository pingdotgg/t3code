// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as RcMap from "effect/RcMap";
import * as Schema from "effect/Schema";

import type {
  FilesystemBrowseInput,
  FilesystemBrowseResult,
  ProjectEntry,
  ProjectListEntriesInput,
  ProjectListEntriesResult,
  ProjectSearchContentsInput,
  ProjectSearchContentsResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { isExplicitRelativePath, isWindowsAbsolutePath } from "@t3tools/shared/path";
import { normalizeSearchQuery } from "@t3tools/shared/searchRanking";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import * as WorkspaceSearchIndex from "./WorkspaceSearchIndex.ts";

const FALLBACK_LIST_MAX_ENTRIES = 25_000;
const FALLBACK_LIST_GIT_OUTPUT_MAX_BYTES = 8_000_000;
const FALLBACK_LIST_EXCLUDED_DIRECTORIES = new Set([".git", ".convex", "node_modules"]);

export class WorkspaceEntriesWindowsPathUnsupportedError extends Schema.TaggedErrorClass<WorkspaceEntriesWindowsPathUnsupportedError>()(
  "WorkspaceEntriesWindowsPathUnsupportedError",
  {
    cwd: Schema.optional(Schema.String),
    partialPath: Schema.String,
    platform: Schema.String,
  },
) {
  override get message(): string {
    const cwd = this.cwd ? ` from '${this.cwd}'` : "";
    return `Windows-style workspace path '${this.partialPath}' is not supported on '${this.platform}'${cwd}.`;
  }
}

export class WorkspaceEntriesCurrentProjectRequiredError extends Schema.TaggedErrorClass<WorkspaceEntriesCurrentProjectRequiredError>()(
  "WorkspaceEntriesCurrentProjectRequiredError",
  {
    partialPath: Schema.String,
  },
) {
  override get message(): string {
    return `A current project is required to browse relative workspace path '${this.partialPath}'.`;
  }
}

export class WorkspaceEntriesReadDirectoryError extends Schema.TaggedErrorClass<WorkspaceEntriesReadDirectoryError>()(
  "WorkspaceEntriesReadDirectoryError",
  {
    cwd: Schema.optional(Schema.String),
    partialPath: Schema.String,
    parentPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const cwd = this.cwd ? ` from '${this.cwd}'` : "";
    return `Failed to read workspace directory '${this.parentPath}' while browsing '${this.partialPath}'${cwd}.`;
  }
}

export const WorkspaceEntriesBrowseError = Schema.Union([
  WorkspaceEntriesWindowsPathUnsupportedError,
  WorkspaceEntriesCurrentProjectRequiredError,
  WorkspaceEntriesReadDirectoryError,
]);
export type WorkspaceEntriesBrowseError = typeof WorkspaceEntriesBrowseError.Type;

export const WorkspaceEntriesError = Schema.Union([
  WorkspacePaths.WorkspaceRootNotExistsError,
  WorkspacePaths.WorkspaceRootCreateFailedError,
  WorkspacePaths.WorkspaceRootStatFailedError,
  WorkspacePaths.WorkspaceRootNotDirectoryError,
  WorkspaceSearchIndex.WorkspaceSearchIndexCreateFailed,
  WorkspaceSearchIndex.WorkspaceSearchIndexScanTimedOut,
  WorkspaceSearchIndex.WorkspaceSearchIndexSearchFailed,
]);
export type WorkspaceEntriesError = typeof WorkspaceEntriesError.Type;

export class WorkspaceEntries extends Context.Service<
  WorkspaceEntries,
  {
    readonly browse: (
      input: FilesystemBrowseInput,
    ) => Effect.Effect<FilesystemBrowseResult, WorkspaceEntriesBrowseError>;
    readonly list: (
      input: ProjectListEntriesInput,
    ) => Effect.Effect<ProjectListEntriesResult, WorkspaceEntriesError>;
    readonly search: (
      input: ProjectSearchEntriesInput,
    ) => Effect.Effect<ProjectSearchEntriesResult, WorkspaceEntriesError>;
    readonly searchContents: (
      input: ProjectSearchContentsInput,
    ) => Effect.Effect<ProjectSearchContentsResult, WorkspaceEntriesError>;
    readonly refresh: (cwd: string) => Effect.Effect<void>;
  }
>()("t3/workspace/WorkspaceEntries") {}

function expandHomePath(input: string, path: Path.Path): string {
  if (input === "~") {
    return NodeOS.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(NodeOS.homedir(), input.slice(2));
  }
  return input;
}

const resolveBrowseTarget = Effect.fn("WorkspaceEntries.resolveBrowseTarget")(function* (
  input: FilesystemBrowseInput,
  path: Path.Path,
): Effect.fn.Return<string, WorkspaceEntriesBrowseError> {
  const platform = yield* HostProcessPlatform;
  if (platform !== "win32" && isWindowsAbsolutePath(input.partialPath)) {
    return yield* new WorkspaceEntriesWindowsPathUnsupportedError({
      cwd: input.cwd,
      partialPath: input.partialPath,
      platform,
    });
  }

  if (!isExplicitRelativePath(input.partialPath)) {
    return path.resolve(expandHomePath(input.partialPath, path));
  }

  if (!input.cwd) {
    return yield* new WorkspaceEntriesCurrentProjectRequiredError({
      partialPath: input.partialPath,
    });
  }
  return path.resolve(expandHomePath(input.cwd, path), input.partialPath);
});

function normalizeFallbackEntryPath(input: string): string {
  return input.replace(/^\.\/+/, "").replace(/\/+$/, "");
}

function isFallbackExcludedPath(input: string): boolean {
  return normalizeFallbackEntryPath(input)
    .split("/")
    .some((segment) => FALLBACK_LIST_EXCLUDED_DIRECTORIES.has(segment));
}

function buildFallbackListResult(
  sourceEntries: ReadonlyArray<ProjectEntry>,
  truncated: boolean,
): ProjectListEntriesResult {
  const entryByPath = new Map<string, ProjectEntry>();
  for (const sourceEntry of sourceEntries) {
    const normalizedPath = normalizeFallbackEntryPath(sourceEntry.path);
    if (!normalizedPath || isFallbackExcludedPath(normalizedPath)) continue;
    entryByPath.set(normalizedPath, { path: normalizedPath, kind: sourceEntry.kind });

    let separatorIndex = normalizedPath.lastIndexOf("/");
    while (separatorIndex > 0) {
      const parentPath = normalizedPath.slice(0, separatorIndex);
      if (!entryByPath.has(parentPath)) {
        entryByPath.set(parentPath, { path: parentPath, kind: "directory" });
      }
      separatorIndex = parentPath.lastIndexOf("/");
    }
  }

  const sortedEntries = [...entryByPath.values()].toSorted((left, right) =>
    left.path.localeCompare(right.path),
  );
  return {
    entries: sortedEntries.slice(0, FALLBACK_LIST_MAX_ENTRIES),
    truncated: truncated || sortedEntries.length > FALLBACK_LIST_MAX_ENTRIES,
  };
}

const listWorkspaceEntriesFromFilesystem = Effect.fn(
  "WorkspaceEntries.listWorkspaceEntriesFromFilesystem",
)(function* (cwd: string, path: Path.Path, vcsProcess: VcsProcess.VcsProcess["Service"]) {
  const gitResult = yield* vcsProcess
    .run({
      operation: "WorkspaceEntries.fallbackList.gitLsFiles",
      command: "git",
      cwd,
      args: ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      allowNonZeroExit: true,
      timeoutMs: 15_000,
      maxOutputBytes: FALLBACK_LIST_GIT_OUTPUT_MAX_BYTES,
    })
    .pipe(Effect.orElseSucceed(() => null));

  if (gitResult !== null && gitResult.exitCode === 0) {
    const files = gitResult.stdout.split("\0").filter(Boolean);
    if (gitResult.stdoutTruncated && !gitResult.stdout.endsWith("\0")) {
      files.pop();
    }
    const exceededEntryLimit = files.length > FALLBACK_LIST_MAX_ENTRIES;
    const boundedFiles = files.slice(0, FALLBACK_LIST_MAX_ENTRIES + 1);
    const ignoredResult = yield* vcsProcess
      .run({
        operation: "WorkspaceEntries.fallbackList.gitCheckIgnore",
        command: "git",
        cwd,
        args: ["check-ignore", "--no-index", "-z", "--stdin"],
        stdin: `${boundedFiles.join("\0")}\0`,
        allowNonZeroExit: true,
        timeoutMs: 15_000,
        maxOutputBytes: FALLBACK_LIST_GIT_OUTPUT_MAX_BYTES,
      })
      .pipe(Effect.orElseSucceed(() => null));
    const ignoredPaths = new Set(
      ignoredResult?.stdout.split("\0").map(normalizeFallbackEntryPath).filter(Boolean) ?? [],
    );
    const entries = yield* Effect.forEach(
      boundedFiles.filter((file) => !ignoredPaths.has(normalizeFallbackEntryPath(file))),
      (file) =>
        Effect.promise(async () => {
          const normalizedPath = normalizeFallbackEntryPath(file);
          try {
            const stat = await NodeFSP.lstat(path.join(cwd, normalizedPath));
            return {
              path: normalizedPath,
              kind: stat.isDirectory() ? ("directory" as const) : ("file" as const),
            };
          } catch {
            return null;
          }
        }),
      { concurrency: 32 },
    );
    return buildFallbackListResult(
      entries.filter((entry): entry is ProjectEntry => entry !== null),
      gitResult.stdoutTruncated || exceededEntryLimit,
    );
  }

  const entries: ProjectEntry[] = [];
  const pendingDirectories = [""];
  let truncated = false;

  while (pendingDirectories.length > 0 && !truncated) {
    const relativeDirectory = pendingDirectories.shift() ?? "";
    const absoluteDirectory = relativeDirectory ? path.join(cwd, relativeDirectory) : cwd;
    const dirents = yield* Effect.promise(() =>
      NodeFSP.readdir(absoluteDirectory, { withFileTypes: true }).catch(() => []),
    );

    for (const dirent of dirents.toSorted((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = normalizeFallbackEntryPath(
        relativeDirectory ? `${relativeDirectory}/${dirent.name}` : dirent.name,
      );
      if (!relativePath || isFallbackExcludedPath(relativePath)) continue;

      const isDirectory = dirent.isDirectory();
      entries.push({
        path: relativePath,
        kind: isDirectory ? "directory" : "file",
      });
      if (entries.length > FALLBACK_LIST_MAX_ENTRIES) {
        truncated = true;
        break;
      }
      if (isDirectory) {
        pendingDirectories.push(relativePath);
      }
    }
  }

  return {
    entries: entries
      .slice(0, FALLBACK_LIST_MAX_ENTRIES)
      .toSorted((left, right) => left.path.localeCompare(right.path)),
    truncated,
  };
});

export const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const workspaceSearchIndexes = yield* WorkspaceSearchIndex.WorkspaceSearchIndexMap;

  const normalizeWorkspaceRoot = Effect.fn("WorkspaceEntries.normalizeWorkspaceRoot")(function* (
    cwd: string,
  ): Effect.fn.Return<string, WorkspaceEntriesError> {
    return yield* workspacePaths.normalizeWorkspaceRoot(cwd);
  });

  const refresh: WorkspaceEntries["Service"]["refresh"] = Effect.fn("WorkspaceEntries.refresh")(
    function* (cwd) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(cwd).pipe(
        Effect.orElseSucceed(() => cwd),
      );
      for (const variant of WorkspaceSearchIndex.WORKSPACE_SEARCH_INDEX_VARIANTS) {
        const indexKey = WorkspaceSearchIndex.workspaceSearchIndexKey(normalizedCwd, variant);
        if (!(yield* RcMap.has(workspaceSearchIndexes.rcMap, indexKey))) {
          continue;
        }
        const recoverRefreshFailure = (
          cause:
            | WorkspaceSearchIndex.WorkspaceSearchIndexCreateFailed
            | WorkspaceSearchIndex.WorkspaceSearchIndexScanTimedOut
            | WorkspaceSearchIndex.WorkspaceSearchIndexRefreshFailed,
        ) =>
          Effect.gen(function* () {
            yield* Effect.logWarning("Failed to refresh workspace search index", {
              cwd,
              variant,
              cause,
            });
            yield* workspaceSearchIndexes.invalidate(indexKey);
          });
        yield* Effect.gen(function* () {
          const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
          yield* searchIndex.refresh();
        }).pipe(
          Effect.provide(workspaceSearchIndexes.get(indexKey)),
          Effect.catchTags({
            WorkspaceSearchIndexCreateFailed: recoverRefreshFailure,
            WorkspaceSearchIndexScanTimedOut: recoverRefreshFailure,
            WorkspaceSearchIndexRefreshFailed: recoverRefreshFailure,
          }),
        );
      }
    },
  );

  const browse: WorkspaceEntries["Service"]["browse"] = Effect.fn("WorkspaceEntries.browse")(
    function* (input) {
      const resolvedInputPath = yield* resolveBrowseTarget(input, path);
      const endsWithSeparator = /[\\/]$/.test(input.partialPath) || input.partialPath === "~";
      const parentPath = endsWithSeparator ? resolvedInputPath : path.dirname(resolvedInputPath);
      const prefix = endsWithSeparator ? "" : path.basename(resolvedInputPath);

      const dirents = yield* Effect.tryPromise({
        try: () => NodeFSP.readdir(parentPath, { withFileTypes: true }),
        catch: (cause) =>
          new WorkspaceEntriesReadDirectoryError({
            cwd: input.cwd,
            partialPath: input.partialPath,
            parentPath,
            cause,
          }),
      }).pipe(
        Effect.catchIf(
          (error) => {
            const code = (error.cause as NodeJS.ErrnoException | undefined)?.code;
            return code === "EACCES" || code === "EPERM";
          },
          () => Effect.succeed([]),
        ),
      );

      const showHidden = endsWithSeparator || prefix.startsWith(".");
      const lowerPrefix = prefix.toLowerCase();
      const entries: Array<{ readonly name: string; readonly fullPath: string }> = [];
      for (const dirent of dirents) {
        if (
          dirent.isDirectory() &&
          dirent.name.toLowerCase().startsWith(lowerPrefix) &&
          (showHidden || !dirent.name.startsWith("."))
        ) {
          entries.push({
            name: dirent.name,
            fullPath: path.join(parentPath, dirent.name),
          });
        }
      }

      return {
        parentPath,
        entries: entries.toSorted((left, right) => left.name.localeCompare(right.name)),
      };
    },
  );

  const search: WorkspaceEntries["Service"]["search"] = Effect.fn("WorkspaceEntries.search")(
    function* (input) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
      const normalizedQuery = normalizeSearchQuery(input.query, {
        trimLeadingPattern: /^[@./]+/,
      });
      return yield* Effect.gen(function* () {
        const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
        return yield* searchIndex.search(normalizedQuery, input.limit, input.kind, input.imageOnly);
      }).pipe(
        Effect.provide(
          workspaceSearchIndexes.get(
            WorkspaceSearchIndex.workspaceSearchIndexKey(normalizedCwd, "paths"),
          ),
        ),
      );
    },
  );

  const searchContents: WorkspaceEntries["Service"]["searchContents"] = Effect.fn(
    "WorkspaceEntries.searchContents",
  )(function* (input) {
    const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
    return yield* Effect.gen(function* () {
      const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
      return yield* searchIndex.searchContents(input);
    }).pipe(
      Effect.provide(
        workspaceSearchIndexes.get(
          WorkspaceSearchIndex.workspaceSearchIndexKey(normalizedCwd, "content"),
        ),
      ),
    );
  });

  const list: WorkspaceEntries["Service"]["list"] = Effect.fn("WorkspaceEntries.list")(
    function* (input) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
      // The fallback only covers an index that could not be created at all
      // (for example the native binding failed to load on this host). Scan
      // timeouts and search failures on a live index still surface so they
      // are not silently masked by a slower listing.
      const recoverWithFilesystemList = (
        cause: WorkspaceSearchIndex.WorkspaceSearchIndexCreateFailed,
      ) =>
        Effect.gen(function* () {
          yield* Effect.logWarning("Falling back to filesystem workspace listing", {
            cwd: normalizedCwd,
            cause,
          });
          return yield* listWorkspaceEntriesFromFilesystem(normalizedCwd, path, vcsProcess);
        });
      return yield* Effect.gen(function* () {
        const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
        return yield* searchIndex.list();
      }).pipe(
        Effect.provide(
          workspaceSearchIndexes.get(
            WorkspaceSearchIndex.workspaceSearchIndexKey(normalizedCwd, "paths"),
          ),
        ),
        Effect.catchTags({ WorkspaceSearchIndexCreateFailed: recoverWithFilesystemList }),
      );
    },
  );

  return WorkspaceEntries.of({ browse, list, refresh, search, searchContents });
});

export const layer = Layer.effect(WorkspaceEntries, make).pipe(
  Layer.provide(WorkspaceSearchIndex.WorkspaceSearchIndexMap.layer),
  Layer.provide(VcsProcess.layer),
);
