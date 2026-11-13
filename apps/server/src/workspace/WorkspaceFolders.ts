import {
  PROJECT_TRACKED_FOLDERS_MAX,
  type ProjectId,
  type ProjectTrackedFolder,
  type TaskFolder,
  type WorkspaceFolder,
  WorkspaceFoldersError,
  type WorkspaceListFoldersInput,
  type WorkspaceListFoldersResult,
  type WorkspaceScanFoldersInput,
  type WorkspaceScanFoldersResult,
} from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { isWithinRoot } from "./KnownWorkspaces.ts";
import * as TaskFolderStore from "./TaskFolderStore.ts";

/** A tracked folder a thread works in, besides its own cwd. */
export interface ThreadFolder {
  readonly name: string;
  readonly path: string;
  readonly isGitRepository: boolean;
  /** The folder `path` is a checkout of. Absent when `path` is that folder. */
  readonly repositoryPath?: string;
}

export interface ThreadWorkspace {
  readonly folders: ReadonlyArray<ThreadFolder>;
  /** Paths of the folders outside the thread's cwd, which an agent needs granted to reach. */
  readonly extraRoots: ReadonlyArray<string>;
}

const EMPTY_WORKSPACE: ThreadWorkspace = { folders: [], extraRoots: [] };
// Each one costs a status per turn.
const THREAD_SUBMODULES_MAX = 32;

export class WorkspaceFolders extends Context.Service<
  WorkspaceFolders,
  {
    /**
     * The tracked folders a thread reaches. A thread in a task folder reaches that folder's
     * worktrees; one in a single worktree reaches none, since the project's checkouts are shared.
     */
    readonly forThread: (input: {
      readonly projectId: ProjectId;
      readonly worktreePath: string | null;
    }) => Effect.Effect<ThreadWorkspace, WorkspaceFoldersError>;
    /**
     * Submodules checked out inside the thread's cwd or its folders. Their repository owns how
     * they get there, so they are reviewed like the folders but never granted or announced.
     */
    readonly submodules: (input: {
      readonly projectId: ProjectId;
      readonly worktreePath: string | null;
    }) => Effect.Effect<ReadonlyArray<ThreadFolder>, WorkspaceFoldersError>;
    readonly list: (
      input: WorkspaceListFoldersInput,
    ) => Effect.Effect<WorkspaceListFoldersResult, WorkspaceFoldersError>;
    readonly scan: (
      input: WorkspaceScanFoldersInput,
    ) => Effect.Effect<WorkspaceScanFoldersResult, WorkspaceFoldersError>;
  }
>()("t3/workspace/WorkspaceFolders") {}

const DETECTION_CONCURRENCY = 8;
const CODE_WORKSPACE_EXTENSION = ".code-workspace";

const decodeCodeWorkspace = Schema.decodeUnknownEffect(
  fromLenientJson(
    Schema.Struct({
      folders: Schema.optional(
        Schema.Array(
          Schema.Struct({
            path: Schema.optional(Schema.String),
            name: Schema.optional(Schema.String),
          }),
        ),
      ),
    }),
  ),
);

/** Submodule paths a `.gitmodules` file declares, relative to its folder with `/` separators. */
export const parseGitmodulesPaths = (text: string): ReadonlyArray<string> =>
  text.split(/\r?\n/).flatMap((line) => {
    const value = /^\s*path\s*=\s*(.*?)\s*$/.exec(line)?.[1];
    if (value === undefined) return [];
    const normalized = value.replaceAll('"', "").replaceAll("\\", "/").replace(/\/+$/, "");
    return normalized === "" ? [] : [normalized];
  });

// Built once per operation: the probes share the caller's file system and path services.
const folderProbes = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const exists = (target: string) =>
    fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false));

  // Sandboxes and containment checks work on what a path resolves to, not on a symlink's name.
  const realPath = (target: string) =>
    fileSystem.realPath(target).pipe(Effect.orElseSucceed(() => target));

  // A repository is a folder with its own `.git`; a folder deeper inside one is plain files.
  // Untraced: it runs once per folder inside the calling operation's span.
  const classify = Effect.fnUntraced(function* (
    folder: ProjectTrackedFolder,
  ): Effect.fn.Return<WorkspaceFolder> {
    if (yield* exists(path.join(folder.path, ".git"))) return { ...folder, state: "git" };
    return { ...folder, state: (yield* exists(folder.path)) ? "plain" : "missing" };
  });

  return { exists, realPath, classify };
});

const readCodeWorkspaceFolders = Effect.fn("WorkspaceFolders.readCodeWorkspaceFolders")(function* (
  root: string,
  fileName: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const document = yield* fileSystem
    .readFileString(path.join(root, fileName))
    .pipe(Effect.flatMap(decodeCodeWorkspace), Effect.option);
  if (Option.isNone(document)) return null;
  return (document.value.folders ?? []).flatMap((folder) => {
    const folderPath = folder.path?.trim();
    if (folderPath === undefined || folderPath === "") return [];
    const resolved = path.resolve(root, folderPath);
    return [{ path: resolved, name: folder.name?.trim() || path.basename(resolved) }];
  });
});

/**
 * Finds the folders worth tracking beside `workspaceRoot`. Exported for the CLI, which scans in
 * its own process: it runs on the server's machine and may have no server to ask.
 */
export const scanFolders = Effect.fn("WorkspaceFolders.scan")(function* (
  input: WorkspaceScanFoldersInput,
): Effect.fn.Return<
  WorkspaceScanFoldersResult,
  WorkspaceFoldersError,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { exists, realPath, classify } = yield* folderProbes;
  const root = path.resolve(
    expandHomePath(input.workspaceRoot.trim(), yield* HostProcess.HomeDirectory),
  );
  const names = (yield* fileSystem
    .readDirectory(root)
    .pipe(
      Effect.mapError(
        () => new WorkspaceFoldersError({ operation: "scan", detail: `Could not read ${root}.` }),
      ),
    )).toSorted();
  const codeWorkspaceFile = names.find((name) => name.endsWith(CODE_WORKSPACE_EXTENSION)) ?? null;
  const listed =
    codeWorkspaceFile === null ? null : yield* readCodeWorkspaceFolders(root, codeWorkspaceFile);
  const children = yield* Effect.forEach(
    names.filter((name) => !name.startsWith(".") && name !== "node_modules"),
    (name) => {
      const folderPath = path.join(root, name);
      return exists(path.join(folderPath, ".git")).pipe(
        Effect.map((isRepository) => (isRepository ? [{ path: folderPath, name }] : [])),
      );
    },
    { concurrency: DETECTION_CONCURRENCY },
  );
  const submodules = new Set(
    parseGitmodulesPaths(
      yield* fileSystem
        .readFileString(path.join(root, ".gitmodules"))
        .pipe(Effect.orElseSucceed(() => "")),
    ),
  );
  const realRoot = yield* realPath(root);
  const resolved = yield* Effect.forEach(
    [
      ...(listed ?? []).map((folder) => ({ ...folder, source: "code-workspace" as const })),
      ...children.flat().map((folder) => ({ ...folder, source: "child" as const })),
    ],
    (folder) => realPath(folder.path).pipe(Effect.map((real) => ({ folder, real }))),
    { concurrency: DETECTION_CONCURRENCY },
  );
  const seen = new Set<string>();
  const candidates = resolved.flatMap(({ folder, real }) => {
    // The scanned folder and its parents are never tracked, however a symlink names them.
    if (seen.has(real) || isWithinRoot(path, realRoot, real)) return [];
    seen.add(real);
    // Submodules follow their parent repository.
    return submodules.has(path.relative(root, folder.path).split(path.sep).join("/"))
      ? []
      : [folder];
  });
  const folders = yield* Effect.forEach(
    candidates.slice(0, PROJECT_TRACKED_FOLDERS_MAX),
    (folder) =>
      classify(folder).pipe(
        Effect.map((classified) =>
          classified.state === "missing"
            ? []
            : [{ ...folder, isGitRepository: classified.state === "git" }],
        ),
      ),
    { concurrency: DETECTION_CONCURRENCY },
  );
  return {
    workspaceRoot: root,
    isGitRepository: yield* exists(path.join(root, ".git")),
    codeWorkspaceFile:
      listed === null || codeWorkspaceFile === null ? null : path.join(root, codeWorkspaceFile),
    folders: folders.flat(),
  };
});

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const taskFolders = yield* TaskFolderStore.TaskFolderStore;

  const { exists, realPath, classify } = yield* folderProbes;

  const readProject = Effect.fn("WorkspaceFolders.readProject")(function* (projectId: ProjectId) {
    const row = yield* projects
      .get(projectId)
      .pipe(
        Effect.mapError(
          () => new WorkspaceFoldersError({ operation: "list", detail: "Failed to read project." }),
        ),
      );
    if (Option.isNone(row)) {
      return yield* new WorkspaceFoldersError({
        operation: "list",
        detail: `Project ${projectId} was not found.`,
      });
    }
    return row.value;
  });

  const classifyAll = (folders: ReadonlyArray<ProjectTrackedFolder>) =>
    Effect.forEach(folders, classify, { concurrency: DETECTION_CONCURRENCY });

  // `identity` is `root` in the checkout the thread's was made from: it names the same submodule
  // in every worktree.
  const submodulesBelow = (root: {
    readonly path: string;
    readonly identity: string;
  }): Effect.Effect<ReadonlyArray<ThreadFolder>> =>
    fileSystem.readFileString(path.join(root.path, ".gitmodules")).pipe(
      Effect.orElseSucceed(() => ""),
      Effect.flatMap((text) =>
        Effect.forEach(
          parseGitmodulesPaths(text),
          (relative) => {
            const folder = path.resolve(root.path, relative);
            const identity = path.resolve(root.identity, relative);
            if (folder === root.path || !isWithinRoot(path, folder, root.path)) {
              return Effect.succeed([]);
            }
            // One that was never initialized is an empty folder.
            return exists(path.join(folder, ".git")).pipe(
              Effect.flatMap((present) =>
                present
                  ? submodulesBelow({ path: folder, identity }).pipe(
                      Effect.map((nested) => [
                        {
                          name: path.basename(folder),
                          path: folder,
                          isGitRepository: true,
                          ...(identity === folder ? {} : { repositoryPath: identity }),
                        },
                        ...nested,
                      ]),
                    )
                  : Effect.succeed([]),
              ),
            );
          },
          { concurrency: DETECTION_CONCURRENCY },
        ),
      ),
      Effect.map((found) => found.flat()),
    );

  const submodulesOf = Effect.fnUntraced(function* (
    roots: ReadonlyArray<{ readonly path: string; readonly identity: string }>,
  ) {
    const found = yield* Effect.forEach(roots, submodulesBelow, {
      concurrency: DETECTION_CONCURRENCY,
    });
    const taken = new Set(roots.map((root) => root.path));
    return found
      .flat()
      .filter((folder) => !taken.has(folder.path))
      .slice(0, THREAD_SUBMODULES_MAX);
  });

  // A task folder's worktrees stand in for the tracked folders: the thread is told about, granted
  // and checkpoints only those, never the checkouts they were made from.
  const forTaskFolder = Effect.fnUntraced(function* (worktreePath: string, taskFolder: TaskFolder) {
    const cwd = yield* realPath(worktreePath);
    const folders = taskFolder.repositories.map((repository) => ({
      name: repository.name,
      path: repository.worktreePath,
      isGitRepository: true,
      repositoryPath: repository.repositoryPath,
    }));
    const outside = yield* Effect.forEach(
      folders,
      (folder) =>
        realPath(folder.path).pipe(
          Effect.map((real) => (isWithinRoot(path, real, cwd) ? [] : [folder.path, real])),
        ),
      { concurrency: DETECTION_CONCURRENCY },
    );
    return { folders, extraRoots: [...new Set(outside.flat())] };
  });

  const forThread: WorkspaceFolders["Service"]["forThread"] = Effect.fn(
    "WorkspaceFolders.forThread",
  )(function* (input) {
    if (input.worktreePath !== null) {
      const taskFolder = yield* taskFolders
        .findContaining(input.worktreePath)
        .pipe(
          Effect.mapError(
            (cause) => new WorkspaceFoldersError({ operation: "list", detail: cause.detail }),
          ),
        );
      return taskFolder === null
        ? EMPTY_WORKSPACE
        : yield* forTaskFolder(input.worktreePath, taskFolder);
    }
    const project = yield* readProject(input.projectId);
    if (project.trackedFolders.length === 0) return EMPTY_WORKSPACE;
    const folders = (yield* classifyAll(project.trackedFolders)).flatMap((folder) =>
      folder.state === "missing"
        ? []
        : [{ name: folder.name, path: folder.path, isGitRepository: folder.state === "git" }],
    );
    const projectRoot = yield* realPath(project.workspaceRoot);
    // Both spellings are granted: agents are told the stored path, sandboxes check the real one.
    const outside = yield* Effect.forEach(
      folders,
      (folder) =>
        realPath(folder.path).pipe(
          Effect.map((real) => (isWithinRoot(path, real, projectRoot) ? [] : [folder.path, real])),
        ),
      { concurrency: DETECTION_CONCURRENCY },
    );
    return { folders, extraRoots: [...new Set(outside.flat())] };
  });

  const submodules: WorkspaceFolders["Service"]["submodules"] = Effect.fn(
    "WorkspaceFolders.submodules",
  )(function* (input) {
    const { folders } = yield* forThread(input);
    // A worktree can outlive its project record; its submodules are then named by where they are.
    const projectRoot = yield* readProject(input.projectId).pipe(
      Effect.map((project) => path.resolve(project.workspaceRoot)),
      Effect.option,
    );
    const own = input.worktreePath === null ? null : path.resolve(input.worktreePath);
    const root = own ?? Option.getOrNull(projectRoot);
    if (root === null) return [];
    const identity = Option.getOrElse(projectRoot, () => root);
    return yield* submodulesOf([
      { path: root, identity },
      ...folders.flatMap((folder) =>
        folder.isGitRepository
          ? [{ path: folder.path, identity: folder.repositoryPath ?? folder.path }]
          : [],
      ),
    ]);
  });

  const list: WorkspaceFolders["Service"]["list"] = Effect.fn("WorkspaceFolders.list")(
    function* (input) {
      return { folders: yield* classifyAll((yield* readProject(input.projectId)).trackedFolders) };
    },
  );

  const scan: WorkspaceFolders["Service"]["scan"] = (input) =>
    scanFolders(input).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  return WorkspaceFolders.of({ forThread, submodules, list, scan });
});

export const layer = Layer.effect(WorkspaceFolders, make);
