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
  FilesystemCreateDirectoryInput,
  FilesystemCreateDirectoryResult,
  ProjectListEntriesInput,
  ProjectListEntriesResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { isExplicitRelativePath, isWindowsAbsolutePath } from "@t3tools/shared/path";

import * as WorkspacePaths from "./WorkspacePaths.ts";
import * as WorkspaceSearchIndex from "./WorkspaceSearchIndex.ts";

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

export class WorkspaceEntriesPathAlreadyExistsError extends Schema.TaggedErrorClass<WorkspaceEntriesPathAlreadyExistsError>()(
  "WorkspaceEntriesPathAlreadyExistsError",
  {
    cwd: Schema.optional(Schema.String),
    partialPath: Schema.String,
    directoryPath: Schema.String,
  },
) {
  override get message(): string {
    const cwd = this.cwd ? ` from '${this.cwd}'` : "";
    return `Filesystem path '${this.directoryPath}' already exists while creating '${this.partialPath}'${cwd}.`;
  }
}

export class WorkspaceEntriesPathNotDirectoryError extends Schema.TaggedErrorClass<WorkspaceEntriesPathNotDirectoryError>()(
  "WorkspaceEntriesPathNotDirectoryError",
  {
    cwd: Schema.optional(Schema.String),
    partialPath: Schema.String,
    directoryPath: Schema.String,
  },
) {
  override get message(): string {
    const cwd = this.cwd ? ` from '${this.cwd}'` : "";
    return `Filesystem path '${this.directoryPath}' is not a directory while creating '${this.partialPath}'${cwd}.`;
  }
}

export class WorkspaceEntriesParentNotFoundError extends Schema.TaggedErrorClass<WorkspaceEntriesParentNotFoundError>()(
  "WorkspaceEntriesParentNotFoundError",
  {
    cwd: Schema.optional(Schema.String),
    partialPath: Schema.String,
    parentPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const cwd = this.cwd ? ` from '${this.cwd}'` : "";
    return `Parent directory '${this.parentPath}' does not exist while creating '${this.partialPath}'${cwd}.`;
  }
}

export class WorkspaceEntriesCreateDirectoryError extends Schema.TaggedErrorClass<WorkspaceEntriesCreateDirectoryError>()(
  "WorkspaceEntriesCreateDirectoryError",
  {
    cwd: Schema.optional(Schema.String),
    partialPath: Schema.String,
    directoryPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const cwd = this.cwd ? ` from '${this.cwd}'` : "";
    return `Failed to create directory '${this.directoryPath}' for '${this.partialPath}'${cwd}.`;
  }
}

export const WorkspaceEntriesResolveTargetError = Schema.Union([
  WorkspaceEntriesWindowsPathUnsupportedError,
  WorkspaceEntriesCurrentProjectRequiredError,
]);
export type WorkspaceEntriesResolveTargetError = typeof WorkspaceEntriesResolveTargetError.Type;

export const WorkspaceEntriesBrowseError = Schema.Union([
  WorkspaceEntriesResolveTargetError,
  WorkspaceEntriesReadDirectoryError,
]);
export type WorkspaceEntriesBrowseError = typeof WorkspaceEntriesBrowseError.Type;

export const WorkspaceEntriesCreateDirectoryErrorUnion = Schema.Union([
  WorkspaceEntriesResolveTargetError,
  WorkspaceEntriesPathAlreadyExistsError,
  WorkspaceEntriesPathNotDirectoryError,
  WorkspaceEntriesParentNotFoundError,
  WorkspaceEntriesCreateDirectoryError,
]);
export type WorkspaceEntriesCreateDirectoryErrorUnion =
  typeof WorkspaceEntriesCreateDirectoryErrorUnion.Type;

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
    readonly createDirectory: (
      input: FilesystemCreateDirectoryInput,
    ) => Effect.Effect<FilesystemCreateDirectoryResult, WorkspaceEntriesCreateDirectoryErrorUnion>;
    readonly list: (
      input: ProjectListEntriesInput,
    ) => Effect.Effect<ProjectListEntriesResult, WorkspaceEntriesError>;
    readonly search: (
      input: ProjectSearchEntriesInput,
    ) => Effect.Effect<ProjectSearchEntriesResult, WorkspaceEntriesError>;
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
): Effect.fn.Return<string, WorkspaceEntriesResolveTargetError> {
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

export const make = Effect.gen(function* () {
  const path = yield* Path.Path;
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
      if (!(yield* RcMap.has(workspaceSearchIndexes.rcMap, normalizedCwd))) {
        return;
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
            cause,
          });
          yield* workspaceSearchIndexes.invalidate(normalizedCwd);
        });
      yield* Effect.gen(function* () {
        const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
        yield* searchIndex.refresh();
      }).pipe(
        Effect.provide(workspaceSearchIndexes.get(normalizedCwd)),
        Effect.catchTags({
          WorkspaceSearchIndexCreateFailed: recoverRefreshFailure,
          WorkspaceSearchIndexScanTimedOut: recoverRefreshFailure,
          WorkspaceSearchIndexRefreshFailed: recoverRefreshFailure,
        }),
      );
    },
  );

  const createDirectory: WorkspaceEntries["Service"]["createDirectory"] = Effect.fn(
    "WorkspaceEntries.createDirectory",
  )(function* (input) {
    const resolvedDirectoryPath = yield* resolveBrowseTarget(input, path);
    const existingStat = yield* Effect.tryPromise({
      try: () => NodeFSP.stat(resolvedDirectoryPath),
      catch: (cause) => cause,
    }).pipe(
      Effect.match({
        onFailure: () => null,
        onSuccess: (stat) => stat,
      }),
    );

    if (existingStat) {
      if (existingStat.isDirectory()) {
        return { directoryPath: resolvedDirectoryPath } as const;
      }
      return yield* new WorkspaceEntriesPathNotDirectoryError({
        cwd: input.cwd,
        partialPath: input.partialPath,
        directoryPath: resolvedDirectoryPath,
      });
    }

    const parentPath = path.dirname(resolvedDirectoryPath);
    const parentStat = yield* Effect.tryPromise({
      try: () => NodeFSP.stat(parentPath),
      catch: (cause) => cause,
    }).pipe(
      Effect.matchEffect({
        onFailure: (cause) =>
          Effect.fail(
            new WorkspaceEntriesParentNotFoundError({
              cwd: input.cwd,
              partialPath: input.partialPath,
              parentPath,
              cause,
            }),
          ),
        onSuccess: Effect.succeed,
      }),
    );
    if (!parentStat.isDirectory()) {
      return yield* new WorkspaceEntriesPathNotDirectoryError({
        cwd: input.cwd,
        partialPath: input.partialPath,
        directoryPath: parentPath,
      });
    }

    yield* Effect.tryPromise({
      try: () => NodeFSP.mkdir(resolvedDirectoryPath),
      catch: (cause) => cause,
    }).pipe(
      Effect.catchIf(
        (cause) => (cause as NodeJS.ErrnoException | undefined)?.code === "EEXIST",
        () =>
          Effect.fail(
            new WorkspaceEntriesPathAlreadyExistsError({
              cwd: input.cwd,
              partialPath: input.partialPath,
              directoryPath: resolvedDirectoryPath,
            }),
          ),
      ),
      Effect.mapError(
        (cause) =>
          new WorkspaceEntriesCreateDirectoryError({
            cwd: input.cwd,
            partialPath: input.partialPath,
            directoryPath: resolvedDirectoryPath,
            cause,
          }),
      ),
    );

    return { directoryPath: resolvedDirectoryPath } as const;
  });

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
      const normalizedQuery = input.query
        .trim()
        .toLowerCase()
        .replace(/^[@./]+/, "");
      return yield* Effect.gen(function* () {
        const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
        return yield* searchIndex.search(normalizedQuery, input.limit);
      }).pipe(Effect.provide(workspaceSearchIndexes.get(normalizedCwd)));
    },
  );

  const list: WorkspaceEntries["Service"]["list"] = Effect.fn("WorkspaceEntries.list")(
    function* (input) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
      return yield* Effect.gen(function* () {
        const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
        return yield* searchIndex.list();
      }).pipe(Effect.provide(workspaceSearchIndexes.get(normalizedCwd)));
    },
  );

  return WorkspaceEntries.of({ browse, createDirectory, list, refresh, search });
});

export const layer = Layer.effect(WorkspaceEntries, make).pipe(
  Layer.provide(WorkspaceSearchIndex.WorkspaceSearchIndexMap.layer),
);
