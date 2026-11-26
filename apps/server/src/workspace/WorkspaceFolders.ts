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
import { splitsSurrogatePair } from "@t3tools/shared/assistantCitations";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import { T3_PROJECT_FILE_NAME } from "@t3tools/contracts";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProcessRunner from "../processRunner.ts";
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
      /** The thread's `forThread` folders; passed in so the project is walked once. */
      readonly folders: ReadonlyArray<ThreadFolder>;
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
// What `ProjectTrackedFolder.name` allows.
const FOLDER_NAME_MAX = 128;
const boundedName = (name: string) => {
  const trimmed = name.trimStart();
  const end = splitsSurrogatePair(trimmed, FOLDER_NAME_MAX) ? FOLDER_NAME_MAX - 1 : FOLDER_NAME_MAX;
  return trimmed.slice(0, end).trimEnd();
};
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
    const value = /^\s*path\s*=\s*(.*?)\s*$/i.exec(line)?.[1];
    if (value === undefined) return [];
    const normalized = value.replaceAll('"', "").replaceAll("\\", "/").replace(/\/+$/, "");
    return normalized === "" ? [] : [normalized];
  });

/**
 * opendir() or a path lookup inside a hung network mount or a macOS privacy-protected folder can
 * wait forever and pins a libuv pool thread that interruption cannot free; four of them wedge
 * every fs and dns call in the server. So the scan looks into folders from a child we can kill.
 */
const OUT_OF_POOL_DEADLINE = "2 seconds";
// A blocked folder is skipped until its child exits, which a hung mount may never let it do,
// then for a while longer before it is looked into again in case it was fixed.
const BLOCKED_FOLDER_RETRY_MS = 5 * 60 * 1000;
const MAX_BLOCKED_FOLDERS = 1024;
const blockedFolders = new Map<string, number>();

// What `$1` holds, deciding on its own `.git` before looking inside, so a hung folder within a
// repository cannot hide it: exits 4 when `$1` has its own history, 3 when it follows another
// repository (a linked worktree or a submodule keeps `.git` as a file), else prints the `.git`
// folders of its children.
const REPOSITORIES_IN_SCRIPT = [
  '[ -d "$1/.git" ] && exit 4; [ -e "$1/.git" ] && exit 3;',
  'exec find -L "$1" -mindepth 1 -maxdepth 2 \\( -name node_modules -o -name ".*" ! -name .git \\) -prune',
  "-o -name .git -type d -print0 -prune",
].join(" ");

class DirectoryListError extends Schema.TaggedError<DirectoryListError>()("DirectoryListError", {
  path: Schema.String,
}) {}

// Built once per operation: the probes share the caller's file system and path services.
const folderProbes = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const isWindows = yield* HostProcess.isWindows;

  /** Runs a probe of `folder` in a child; none when it failed to run or `folder` is blocked. */
  const runOutOfPool = Effect.fnUntraced(function* (
    folder: string,
    command: string,
    args: ReadonlyArray<string>,
  ) {
    if ((blockedFolders.get(folder) ?? 0) > (yield* Clock.currentTimeMillis)) {
      return Option.none<ProcessRunner.ProcessRunOutput>();
    }
    blockedFolders.delete(folder);
    // Detached: a killed child stuck in the kernel never exits, and the deadline must not wait
    // for it. The run enforces its own deadline, so it still ends if this caller goes away.
    const run = yield* processRunner
      .run({
        command,
        args,
        timeout: OUT_OF_POOL_DEADLINE,
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.forkDetach);
    const result = yield* Fiber.join(run).pipe(
      Effect.timeoutOption(OUT_OF_POOL_DEADLINE),
      Effect.orElseSucceed(() => Option.none<ProcessRunner.ProcessRunOutput>()),
    );
    if (Option.isSome(result) && !result.value.timedOut) return result;
    if (blockedFolders.size >= MAX_BLOCKED_FOLDERS) {
      blockedFolders.delete(blockedFolders.keys().next().value!);
    }
    blockedFolders.set(folder, Number.POSITIVE_INFINITY);
    yield* Effect.forkDetach(
      Effect.gen(function* () {
        yield* Fiber.await(run);
        const exited = yield* Clock.currentTimeMillis;
        if (blockedFolders.has(folder))
          blockedFolders.set(folder, exited + BLOCKED_FOLDER_RETRY_MS);
      }),
    );
    return Option.none<ProcessRunner.ProcessRunOutput>();
  });

  const nulSeparated = (stdout: string) => stdout.split("\0").filter((entry) => entry !== "");

  /** The names in `folder`, like `readDirectory`, without holding a libuv pool thread. */
  const listDirectory = Effect.fnUntraced(function* (
    folder: string,
  ): Effect.fn.Return<ReadonlyArray<string>, DirectoryListError> {
    const failed = new DirectoryListError({ path: folder });
    // No privacy prompts here, and no `find` with these flags.
    if (isWindows) {
      return yield* fileSystem.readDirectory(folder).pipe(Effect.mapError(() => failed));
    }
    const result = yield* runOutOfPool(folder, "find", [
      "-H",
      folder,
      "-mindepth",
      "1",
      "-maxdepth",
      "1",
      "-print0",
    ]);
    if (Option.isNone(result)) return yield* failed;
    const names = nulSeparated(result.value.stdout).map((entry) => path.basename(entry));
    // `find` exits non-zero for an entry it could not stat, too; only an empty failure is one.
    if (result.value.code !== 0 && names.length === 0) return yield* failed;
    return names;
  });
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

  // A linked worktree and a submodule keep `.git` as a file; both follow another repository.
  const ownsHistory = (folder: string) =>
    fileSystem.stat(path.join(folder, ".git")).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.orElseSucceed(() => false),
    );

  const childFolders = (folder: string) =>
    fileSystem.readDirectory(folder).pipe(
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
      Effect.map((names) =>
        names
          .filter((name) => !name.startsWith(".") && name !== "node_modules")
          .toSorted()
          .map((name) => path.join(folder, name)),
      ),
    );

  /**
   * The repositories `folder` is or holds: itself when it has its own history, none when it
   * follows another repository, else its children with their own history. A plain folder is
   * looked into once: wrappers keep repositories under folders such as `src` or `packages`.
   */
  const repositoriesIn = Effect.fnUntraced(function* (folder: string) {
    // No privacy prompts here, and no `sh` or `find`.
    if (isWindows) {
      if (yield* ownsHistory(folder)) return [folder];
      if (yield* exists(path.join(folder, ".git"))) return [];
      return yield* Effect.filter(yield* childFolders(folder), ownsHistory, {
        concurrency: DETECTION_CONCURRENCY,
      });
    }
    const result = yield* runOutOfPool(folder, "sh", ["-c", REPOSITORIES_IN_SCRIPT, "sh", folder]);
    if (Option.isNone(result)) return [];
    if (result.value.code === 4) return [folder];
    if (result.value.code === 3) return [];
    return nulSeparated(result.value.stdout)
      .map((gitFolder) => path.dirname(gitFolder))
      .filter((nested) => path.dirname(nested) === folder)
      .toSorted();
  });

  return { exists, realPath, classify, ownsHistory, listDirectory, repositoriesIn };
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
    return [
      {
        path: resolved,
        name: boundedName(folder.name?.trim() ?? "") || boundedName(path.basename(resolved)),
      },
    ];
  });
});

/**
 * Finds the repositories under `workspaceRoot` and the folders its `.code-workspace` file lists.
 */
const scanFolders = Effect.fn("WorkspaceFolders.scan")(function* (
  input: WorkspaceScanFoldersInput,
  limit: number = PROJECT_TRACKED_FOLDERS_MAX,
): Effect.fn.Return<
  WorkspaceScanFoldersResult,
  WorkspaceFoldersError,
  FileSystem.FileSystem | Path.Path | ProcessRunner.ProcessRunner
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { exists, realPath, classify, listDirectory, repositoriesIn } = yield* folderProbes;
  const root = path.resolve(
    expandHomePath(input.workspaceRoot.trim(), yield* HostProcess.HomeDirectory),
  );
  const names = (yield* listDirectory(root).pipe(
    Effect.mapError(
      () => new WorkspaceFoldersError({ operation: "scan", detail: `Could not read ${root}.` }),
    ),
  )).toSorted();
  const codeWorkspaceFile = names.find((name) => name.endsWith(CODE_WORKSPACE_EXTENSION)) ?? null;
  const listed =
    codeWorkspaceFile === null ? null : yield* readCodeWorkspaceFolders(root, codeWorkspaceFile);
  // A worktree of another repository is that repository's, so only folders with their own
  // history are offered.
  const children = yield* Effect.forEach(
    names.filter((name) => !name.startsWith(".") && name !== "node_modules"),
    (name) =>
      repositoriesIn(path.join(root, name)).pipe(
        Effect.map((found) =>
          found.map((folder) => ({ path: folder, name: boundedName(path.basename(folder)) })),
        ),
      ),
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
  // Capped after the missing ones are dropped: dead entries must not hide the folders that exist.
  const folders = yield* Effect.forEach(
    candidates,
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
    folders: folders.flat().slice(0, limit),
  };
});

/**
 * The repositories inside a project folder, read from disk: the ones a scan finds there, less
 * those the project's `t3.json` leaves out. A folder outside it is never found this way, since
 * tracking one grants agents a place they could not reach before.
 */
export const discoverFolders = Effect.fn("WorkspaceFolders.discover")(function* (
  workspaceRoot: string,
): Effect.fn.Return<
  ReadonlyArray<ProjectTrackedFolder>,
  never,
  FileSystem.FileSystem | Path.Path | ProcessRunner.ProcessRunner
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { realPath, ownsHistory } = yield* folderProbes;
  const root = path.resolve(expandHomePath(workspaceRoot.trim(), yield* HostProcess.HomeDirectory));
  const ignored = (
    parseT3ProjectFile(
      yield* fileSystem
        .readFileString(path.join(root, T3_PROJECT_FILE_NAME))
        .pipe(Effect.orElseSucceed(() => "")),
    )?.ignoreRepositories ?? []
  ).map((entry) => path.resolve(root, entry));
  // Everything the scan could find would be dropped, so skip the walk.
  if (ignored.some((entry) => isWithinRoot(path, root, entry))) return [];
  // Uncapped: the folders outside the project are dropped below, and must not use up the room.
  const scan = yield* scanFolders({ workspaceRoot }, Number.POSITIVE_INFINITY).pipe(Effect.option);
  if (Option.isNone(scan)) return [];
  const realRoot = yield* realPath(root);
  const inside = yield* Effect.filter(
    scan.value.folders.filter(
      (folder) =>
        folder.isGitRepository &&
        !ignored.some((entry) => folder.path === entry || isWithinRoot(path, folder.path, entry)),
    ),
    // A link to a repository elsewhere is not inside the project, whatever its name says, and a
    // worktree a workspace file lists follows another repository.
    (folder) =>
      Effect.all([realPath(folder.path), ownsHistory(folder.path)]).pipe(
        Effect.map(
          ([real, owns]) => owns && real !== realRoot && isWithinRoot(path, real, realRoot),
        ),
      ),
    { concurrency: DETECTION_CONCURRENCY },
  );
  return inside.map((folder) => ({ path: folder.path, name: folder.name, discovered: true }));
});

/**
 * The found repositories, then the folders someone added. Someone chose the added ones, so the
 * found ones give way when both do not fit.
 */
export const mergeProjectFolders = (
  discovered: ReadonlyArray<ProjectTrackedFolder>,
  trackedFolders: ReadonlyArray<ProjectTrackedFolder>,
): ReadonlyArray<ProjectTrackedFolder> => {
  const found = new Set(discovered.map((folder) => folder.path));
  const added = trackedFolders
    .filter((folder) => folder.discovered !== true && !found.has(folder.path))
    .slice(0, PROJECT_TRACKED_FOLDERS_MAX);
  return [...discovered.slice(0, PROJECT_TRACKED_FOLDERS_MAX - added.length), ...added];
};

/**
 * Every folder a project works in besides its own: the repositories found inside it now, then
 * the folders someone added. Read from disk each time, so a clone or a removal shows at once.
 */
export const projectFolders = Effect.fn("WorkspaceFolders.projectFolders")(function* (project: {
  readonly workspaceRoot: string;
  readonly trackedFolders: ReadonlyArray<ProjectTrackedFolder>;
}): Effect.fn.Return<
  ReadonlyArray<ProjectTrackedFolder>,
  never,
  FileSystem.FileSystem | Path.Path | ProcessRunner.ProcessRunner
> {
  return mergeProjectFolders(yield* discoverFolders(project.workspaceRoot), project.trackedFolders);
});

/** Whether two tracked lists name the same folders in the same order. */
export const sameProjectFolders = (
  left: ReadonlyArray<ProjectTrackedFolder>,
  right: ReadonlyArray<ProjectTrackedFolder>,
) =>
  left.length === right.length &&
  left.every((folder, index) => {
    const other = right[index]!;
    return (
      folder.path === other.path &&
      folder.name === other.name &&
      (folder.discovered === true) === (other.discovered === true)
    );
  });

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const taskFolders = yield* TaskFolderStore.TaskFolderStore;
  const processRunner = yield* ProcessRunner.make();

  const { exists, realPath, classify } = yield* folderProbes.pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
  );

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
  const foldersOf = (project: {
    readonly workspaceRoot: string;
    readonly trackedFolders: ReadonlyArray<ProjectTrackedFolder>;
  }) =>
    projectFolders(project).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
    );

  // `identity` is `root` in the checkout the thread's was made from: it names the same submodule
  // in every worktree. `budget` is shared by one listing: a `.gitmodules` file is untrusted, and
  // one that repeats a path or links back to its parent would otherwise be walked without end.
  const submodulesBelow = (
    root: { readonly path: string; readonly identity: string },
    budget: { left: number; readonly visited: Set<string> },
  ): Effect.Effect<ReadonlyArray<ThreadFolder>> =>
    fileSystem.readFileString(path.join(root.path, ".gitmodules")).pipe(
      Effect.orElseSucceed(() => ""),
      Effect.flatMap((text) =>
        Effect.forEach(
          [...new Set(parseGitmodulesPaths(text))],
          Effect.fnUntraced(function* (relative) {
            const folder = path.resolve(root.path, relative);
            const identity = path.resolve(root.identity, relative);
            if (folder === root.path || !isWithinRoot(path, folder, root.path)) return [];
            // One that was never initialized is an empty folder.
            if (budget.left <= 0 || !(yield* exists(path.join(folder, ".git")))) return [];
            const real = yield* realPath(folder);
            // A committed symlink on the way must not lead the thread out of its repository.
            if (!isWithinRoot(path, real, yield* realPath(root.path))) return [];
            if (budget.left <= 0 || budget.visited.has(real)) return [];
            budget.visited.add(real);
            budget.left -= 1;
            return [
              {
                name: path.basename(folder),
                path: folder,
                isGitRepository: true,
                ...(identity === folder ? {} : { repositoryPath: identity }),
              },
              ...(yield* submodulesBelow({ path: folder, identity }, budget)),
            ];
          }),
          { concurrency: DETECTION_CONCURRENCY },
        ),
      ),
      Effect.map((found) => found.flat()),
    );

  const submodulesOf = Effect.fnUntraced(function* (
    roots: ReadonlyArray<{ readonly path: string; readonly identity: string }>,
  ) {
    const budget = {
      left: THREAD_SUBMODULES_MAX,
      visited: new Set(
        yield* Effect.forEach(roots, (root) => realPath(root.path), {
          concurrency: DETECTION_CONCURRENCY,
        }),
      ),
    };
    const found = yield* Effect.forEach(roots, (root) => submodulesBelow(root, budget), {
      concurrency: DETECTION_CONCURRENCY,
    });
    const taken = new Set(roots.map((root) => root.path));
    return found.flat().filter((folder) => !taken.has(folder.path));
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
    const tracked = yield* foldersOf(project);
    if (tracked.length === 0) return EMPTY_WORKSPACE;
    const folders = (yield* classifyAll(tracked)).flatMap((folder) =>
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
      ...input.folders.flatMap((folder) =>
        folder.isGitRepository
          ? [{ path: folder.path, identity: folder.repositoryPath ?? folder.path }]
          : [],
      ),
    ]);
  });

  const list: WorkspaceFolders["Service"]["list"] = Effect.fn("WorkspaceFolders.list")(
    function* (input) {
      const project = yield* readProject(input.projectId);
      return { folders: yield* classifyAll(yield* foldersOf(project)) };
    },
  );

  const scan: WorkspaceFolders["Service"]["scan"] = (input) =>
    scanFolders(input).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
    );

  return WorkspaceFolders.of({ forThread, submodules, list, scan });
});

export const layer = Layer.effect(WorkspaceFolders, make);
