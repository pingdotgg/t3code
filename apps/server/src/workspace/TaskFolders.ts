import {
  type ProjectId,
  type ProjectTrackedFolder,
  TASK_FOLDER_DEFAULT_REPOSITORIES_MAX,
  type TaskFolder,
  TaskFolderError,
  type TaskFolderRepository,
  type ThreadId,
  type VcsCreateWorktreeInput,
  type VcsCreateWorktreeResult,
  T3_PROJECT_FILE_NAME,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { flattenTemporaryWorktreeBranchName, isTemporaryWorktreeBranch } from "@t3tools/shared/git";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  removeEmptyDirectory,
  type RemoveEmptyDirectoryError,
} from "../vcs/removeEmptyDirectory.ts";
import { resolveWorktreesDirectory } from "../worktreesDirectory.ts";
import { isWithinRoot } from "./KnownWorkspaces.ts";
import * as TaskFolderStore from "./TaskFolderStore.ts";
import { projectFolders, parseGitmodulesPaths } from "./WorkspaceFolders.ts";
import { withWorkspaceLease } from "./workspaceLease.ts";

// Each worktree is a checkout: enough at once to finish four repositories together, few enough
// to leave Git's server-wide process slots to running threads.
const REPOSITORY_CONCURRENCY = 4;
const LAYOUT_COMMAND_TIMEOUT_MS = 600_000;
const BRANCH_NAME_ATTEMPTS = 50;

/** What a new task folder will hold, decided before anything is created. */
export interface TaskFolderPlan {
  readonly projectId: ProjectId;
  readonly projectRoot: string;
  readonly projectIsRepository: boolean;
  readonly anchor: string;
  /** The tracked Git folders that get a worktree. */
  readonly repositories: ReadonlyArray<ProjectTrackedFolder>;
  /** Every tracked Git folder. None is linked into a plain project folder: a link is the original. */
  readonly trackedRepositories: ReadonlyArray<string>;
}

interface TaskFolderRemoval {
  readonly removed: ReadonlyArray<string>;
  readonly kept: ReadonlyArray<{ readonly path: string; readonly reason: string }>;
}

/** One checkout of a task folder, as removal sees it. */
interface TaskFolderCheckout {
  readonly worktreePath: string;
  /** The checkout this is a worktree of. */
  readonly repositoryPath: string;
}

export class TaskFolders extends Context.Service<
  TaskFolders,
  {
    /**
     * Null when the project tracks no Git folder: its worktree is then a single checkout, made as
     * it always was. Omitted `repositories` selects every tracked Git folder up to
     * `TASK_FOLDER_DEFAULT_REPOSITORIES_MAX`, and none beyond that.
     */
    readonly plan: (input: {
      readonly projectId: ProjectId;
      readonly repositories?: ReadonlyArray<{ readonly path: string }> | undefined;
    }) => Effect.Effect<TaskFolderPlan | null, TaskFolderError>;
    /**
     * Creates the folder and every worktree on one branch name, which is `branch` unless a
     * selected repository already has it. A failure removes what this call created.
     */
    readonly create: (input: {
      readonly plan: TaskFolderPlan;
      readonly branch: string;
      /** Where the project folder's branch starts; unused when it is not a repository. */
      readonly projectStart: { readonly refName: string; readonly baseRefName: string };
      /**
       * The branch the thread starts from. A repository that has it starts there; one that does
       * not starts from its own default branch.
       */
      readonly baseBranch?: string | undefined;
      readonly startFromOrigin: boolean;
      readonly projectProgress?: GitVcsDriver.CreateWorktreeProgress;
      /** As soon as the folder is recorded, so a cancelled caller knows what to remove. */
      readonly onClaimed?: (taskFolder: TaskFolder, branch: string) => Effect.Effect<void>;
      readonly onRepository?: (progress: {
        readonly name: string;
        readonly done: number;
        readonly total: number;
      }) => Effect.Effect<void>;
    }) => Effect.Effect<
      {
        readonly taskFolder: TaskFolder;
        readonly branch: string;
        /** The project's own command made the checkouts, from whatever start it chose. */
        readonly laidOutByProject: boolean;
        /** A repository's worktree starts from the commit just fetched from its remote. */
        readonly repositoriesStartedFromOrigin: boolean;
      },
      TaskFolderError
    >;
    /**
     * The worktree an existing thread asks for in its project folder: a task folder with the
     * default repositories when the project there tracks Git folders. Null otherwise, and for a
     * request that names its path or checks out an existing branch, which stay a single worktree.
     */
    readonly createForProjectFolder: (
      input: VcsCreateWorktreeInput,
    ) => Effect.Effect<VcsCreateWorktreeResult | null, TaskFolderError>;
    /**
     * Gives a tracked Git folder its worktree in a thread's task folder, on the thread's branch.
     * `startFromOrigin` defaults to the project's setting for new worktrees.
     */
    readonly addRepository: (input: {
      readonly threadId: ThreadId;
      readonly repositoryPath: string;
      readonly startFromOrigin?: boolean | undefined;
    }) => Effect.Effect<TaskFolder, TaskFolderError>;
    /** The task folder that is, or contains, `target`. */
    readonly find: (target: string) => Effect.Effect<TaskFolder | null, TaskFolderError>;
    /**
     * Removes repository worktrees, then the project folder, then the links and the folder.
     * `inspect` may keep a checkout, with the reason to report, or allow forcing it; without it
     * every checkout is removed with `force`. `forget` drops the record, shrinking it to what was
     * kept; otherwise the record stays so the folder can be restored when its thread resumes.
     */
    readonly remove: (input: {
      readonly root: string;
      readonly force: boolean;
      readonly forget: boolean;
      readonly deleteBranch?: string | undefined;
      readonly inspect?: (
        checkout: TaskFolderCheckout,
      ) => Effect.Effect<{ readonly keep: string | null; readonly force: boolean }>;
    }) => Effect.Effect<TaskFolderRemoval, TaskFolderError>;
    /**
     * Removes the task folder `path` is the root or the project folder of, for good. False when
     * it is neither, and a failure naming what could not be removed.
     */
    readonly removeIfTaskFolder: (input: {
      readonly path: string;
      readonly force: boolean;
    }) => Effect.Effect<boolean, TaskFolderError>;
    /** Renames the branch in every checkout to one name free in all of them. */
    readonly renameBranch: (input: {
      readonly root: string;
      readonly oldBranch: string;
      readonly newBranch: string;
      readonly exactName?: boolean;
    }) => Effect.Effect<{ readonly branch: string }, TaskFolderError>;
    /** Puts back whatever is missing; `recreate` checks a branch out again at a path. */
    readonly restore: <E>(input: {
      readonly taskFolder: TaskFolder;
      /** The thread's branch, for a project that lays its folder out with its own command. */
      readonly branch: string;
      readonly recreate: (checkout: TaskFolderCheckout) => Effect.Effect<void, E>;
    }) => Effect.Effect<void, TaskFolderError | E>;
  }
>()("t3/workspace/TaskFolders") {}

const isTaskFolderError = Schema.is(TaskFolderError);

const failureDetail = (cause: unknown) =>
  typeof cause === "object" &&
  cause !== null &&
  "detail" in cause &&
  typeof cause.detail === "string"
    ? cause.detail
    : cause instanceof Error
      ? cause.message
      : String(cause);

/** The deepest folder that holds every one of `folders`, or null when they share none. */
export const commonAncestor = (path: Path.Path, folders: ReadonlyArray<string>) => {
  let ancestor = folders[0]!;
  for (const folder of folders.slice(1)) {
    while (!isWithinRoot(path, folder, ancestor)) {
      const parent = path.dirname(ancestor);
      // Two Windows drives meet nowhere, and a drive root is its own parent.
      if (parent === ancestor) return null;
      ancestor = parent;
    }
  }
  return ancestor;
};

/**
 * The folder a task folder mirrors: the deepest one holding the project and every tracked
 * repository that shares a root with it. The rest are `unreachable` and cannot be laid out.
 */
export const layoutAnchor = (
  path: Path.Path,
  projectRoot: string,
  repositories: ReadonlyArray<string>,
) => {
  let anchor = projectRoot;
  const unreachable: string[] = [];
  for (const repository of repositories) {
    const shared = commonAncestor(path, [anchor, repository]);
    if (shared === null) unreachable.push(repository);
    else anchor = shared;
  }
  return { anchor, unreachable };
};

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const digest = yield* Digest.Digest;
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const git = yield* GitWorkflowService.GitWorkflowService;
  const gitDriver = yield* GitVcsDriver.GitVcsDriver;
  const store = yield* TaskFolderStore.TaskFolderStore;
  const processes = yield* VcsProcess.VcsProcess;
  const hostEnvironment = yield* HostProcess.Environment;
  const hostPlatform = yield* HostProcess.Platform;
  const onWindows = yield* HostProcess.isWindows;
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  const exists = (target: string) =>
    fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false));
  const isRepository = (folder: string) => exists(path.join(folder, ".git"));
  const occupied = Effect.fnUntraced(function* (target: string) {
    if (!(yield* exists(target))) return false;
    const isDirectory = (yield* fileSystem.stat(target).pipe(Effect.option)).pipe(
      Option.exists((info) => info.type === "Directory"),
    );
    if (!isDirectory) return true;
    return (
      (yield* fileSystem.readDirectory(target).pipe(Effect.orElseSucceed(() => [""]))).length > 0
    );
  });
  const trackedFolders = (project: {
    readonly workspaceRoot: string;
    readonly trackedFolders: ReadonlyArray<ProjectTrackedFolder>;
  }) =>
    projectFolders(project).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
  // The repository that pins a submodule owns its checkout: Git, a hook or a setup script puts it
  // in that repository's worktree, so it never gets one of its own here.
  const isSubmodule = Effect.fnUntraced(function* (folder: string) {
    for (
      let owner = path.dirname(folder);
      owner !== path.dirname(owner);
      owner = path.dirname(owner)
    ) {
      if (!(yield* isRepository(owner))) continue;
      const declared = yield* fileSystem
        .readFileString(path.join(owner, ".gitmodules"))
        .pipe(Effect.orElseSucceed(() => ""));
      return parseGitmodulesPaths(declared).includes(
        path.relative(owner, folder).split(path.sep).join("/"),
      );
    }
    return false;
  });
  const fail =
    (operation: TaskFolderError["operation"], prefix: string) =>
    (cause: unknown): TaskFolderError =>
      new TaskFolderError({ operation, detail: `${prefix}: ${failureDetail(cause)}`, cause });

  // A project that lays its own thread folder out says so in its `t3.json`.
  const worktreeLayout = (projectRoot: string) =>
    fileSystem.readFileString(path.join(projectRoot, T3_PROJECT_FILE_NAME)).pipe(
      Effect.map((contents) => parseT3ProjectFile(contents)?.worktreeLayout ?? null),
      Effect.orElseSucceed(() => null),
    );
  // One at a time per project: the commands share the project folder, and its workspace files.
  const layoutLocks = yield* KeyedLock.make<string>();
  const runLayoutCommand = (
    operation: TaskFolderError["operation"],
    command: string,
    taskFolder: Pick<TaskFolder, "root" | "projectRoot" | "projectPath">,
    branch: string,
    baseBranch: string | undefined,
    repositories: ReadonlyArray<string>,
  ) =>
    layoutLocks.withLock(
      taskFolder.projectRoot,
      processes
        .run({
          operation: "TaskFolders.worktreeLayout",
          command: onWindows ? "cmd.exe" : "sh",
          args: onWindows ? ["/d", "/s", "/c", command] : ["-c", command],
          cwd: taskFolder.projectRoot,
          env: {
            ...hostEnvironment,
            // A `GIT_DIR` the server inherited would point the command's Git at another repository.
            ...VcsProcess.unsetInheritedRepositoryEnv(hostEnvironment, hostPlatform),
            T3_PROJECT_ROOT: taskFolder.projectRoot,
            T3_WORKTREE_ROOT: taskFolder.root,
            T3_WORKTREE_PROJECT_PATH: taskFolder.projectPath,
            T3_WORKTREE_BRANCH: branch,
            T3_WORKTREE_BASE: baseBranch ?? "",
            T3_WORKTREE_REPOSITORIES: repositories.join("\n"),
          },
          timeoutMs: LAYOUT_COMMAND_TIMEOUT_MS,
        })
        .pipe(Effect.mapError(fail(operation, "The project's worktree layout command failed"))),
    );

  /** Where a folder's `.git` file points, or null when `.git` is a directory or absent. */
  const gitDirPointer = Effect.fnUntraced(function* (folder: string) {
    const pointer = yield* fileSystem
      .readFileString(path.join(folder, ".git"))
      .pipe(Effect.orElseSucceed(() => ""));
    const gitDir = /^gitdir:\s*(.+?)\s*$/m.exec(pointer)?.[1];
    return gitDir === undefined ? null : path.resolve(folder, gitDir);
  });
  // A repository that is itself a linked worktree registers worktrees under the Git dir it shares.
  const commonGitDir = Effect.fnUntraced(function* (repositoryPath: string) {
    const gitDir = yield* gitDirPointer(repositoryPath);
    if (gitDir === null) return path.join(repositoryPath, ".git");
    const common = (yield* fileSystem
      .readFileString(path.join(gitDir, "commondir"))
      .pipe(Effect.orElseSucceed(() => ""))).trim();
    return common === "" ? gitDir : path.resolve(gitDir, common);
  });

  // What a layout command leaves must be a checkout this service can later remove, restore and
  // rename: a worktree linked to the repository, on the thread's branch. Null when it is.
  /** The checkout's own Git directory when it is a worktree linked to its repository. */
  const linkedGitDir = Effect.fnUntraced(function* (checkout: TaskFolderCheckout) {
    const real = (target: string) =>
      fileSystem.realPath(target).pipe(Effect.orElseSucceed(() => target));
    const resolved = yield* gitDirPointer(checkout.worktreePath);
    if (
      resolved === null ||
      !isWithinRoot(
        path,
        yield* real(resolved),
        path.join(yield* real(yield* commonGitDir(checkout.repositoryPath)), "worktrees"),
      )
    )
      return null;
    // Git registers one path per worktree: a copy of the checkout elsewhere points here too.
    const registered = (yield* fileSystem
      .readFileString(path.join(resolved, "gitdir"))
      .pipe(Effect.orElseSucceed(() => ""))).trim();
    return registered !== "" &&
      (yield* real(path.dirname(registered))) === (yield* real(checkout.worktreePath))
      ? resolved
      : null;
  });
  const unadoptable = Effect.fnUntraced(function* (checkout: TaskFolderCheckout, branch: string) {
    const resolved = yield* linkedGitDir(checkout);
    if (resolved === null)
      return `${checkout.worktreePath} is not a Git worktree of ${checkout.repositoryPath}`;
    const head = (yield* fileSystem
      .readFileString(path.join(resolved, "HEAD"))
      .pipe(Effect.orElseSucceed(() => ""))).trim();
    return head === `ref: refs/heads/${branch}`
      ? null
      : `${checkout.worktreePath} is not on the branch ${branch}`;
  });

  const mapped = (taskFolder: Pick<TaskFolder, "root" | "anchor">, source: string) =>
    path.join(taskFolder.root, path.relative(taskFolder.anchor, source));
  const depth = (target: string) => path.resolve(target).split(path.sep).length;

  const readProject = Effect.fn("TaskFolders.readProject")(function* (
    operation: TaskFolderError["operation"],
    projectId: ProjectId,
  ) {
    const row = yield* projects
      .get(projectId)
      .pipe(Effect.mapError(fail(operation, "Could not read the project")));
    if (Option.isNone(row)) {
      return yield* new TaskFolderError({
        operation,
        detail: `Project ${projectId} was not found.`,
      });
    }
    return row.value;
  });

  const plan: TaskFolders["Service"]["plan"] = Effect.fn("TaskFolders.plan")(function* (input) {
    const project = yield* readProject("plan", input.projectId);
    const projectRoot = path.resolve(project.workspaceRoot);
    const classified = yield* Effect.forEach(
      yield* trackedFolders(project),
      (folder) => {
        const folderPath = path.resolve(folder.path);
        return Effect.all([isRepository(folderPath), isSubmodule(folderPath)]).pipe(
          Effect.map(([git, submodule]) => ({
            name: folder.name,
            path: folderPath,
            git,
            submodule,
          })),
        );
      },
      { concurrency: 8 },
    );
    const tracked = classified.filter(
      (folder) => folder.git && !folder.submodule && folder.path !== projectRoot,
    );
    // A project that lays its own thread folder out gets one even with nothing else to check out.
    // An explicit choice still goes through the checks below, so it is refused, not dropped.
    if (
      tracked.length === 0 &&
      (input.repositories ?? []).length === 0 &&
      (yield* worktreeLayout(projectRoot)) === null
    )
      return null;
    // A repository on another Windows drive has no place in the folder; only choosing it fails.
    const { anchor, unreachable } = layoutAnchor(
      path,
      projectRoot,
      tracked.map((folder) => folder.path),
    );
    const reachable = tracked.filter((folder) => !unreachable.includes(folder.path));
    let repositories: ReadonlyArray<ProjectTrackedFolder>;
    if (input.repositories === undefined) {
      repositories = reachable.length <= TASK_FOLDER_DEFAULT_REPOSITORIES_MAX ? reachable : [];
    } else {
      const selected = new Map<string, ProjectTrackedFolder>();
      for (const requested of input.repositories) {
        const requestedPath = path.resolve(requested.path);
        const folder = classified.find((candidate) => candidate.path === requestedPath);
        // A submodule comes with its repository's worktree; clients cannot tell one apart.
        if (folder?.submodule === true) continue;
        if (folder === undefined || !folder.git || folder.path === projectRoot) {
          return yield* new TaskFolderError({
            operation: "plan",
            detail:
              folder === undefined
                ? `"${requested.path}" is not a tracked folder of project "${project.title}".`
                : `"${requested.path}" is not a Git repository, so it cannot get a worktree.`,
          });
        }
        if (unreachable.includes(folder.path)) {
          return yield* new TaskFolderError({
            operation: "plan",
            detail: `"${folder.path}" shares no common root with the project folder ${projectRoot}, so the two cannot be laid out in one worktree folder.`,
          });
        }
        selected.set(folder.path, folder);
      }
      repositories = [...selected.values()];
    }
    // A repository with no commit yet has nothing to branch from, so it is left out.
    repositories = yield* Effect.filter(
      repositories,
      (folder) =>
        git.hasCommit({ cwd: folder.path, refName: "HEAD" }).pipe(Effect.orElseSucceed(() => true)),
      { concurrency: REPOSITORY_CONCURRENCY },
    );
    return {
      projectId: project.projectId,
      projectRoot,
      projectIsRepository: yield* isRepository(projectRoot),
      anchor,
      repositories: repositories.map(({ name, path: folderPath }) => ({ name, path: folderPath })),
      trackedRepositories: reachable.map((folder) => folder.path),
    };
  });

  const branchNames = (cwds: ReadonlyArray<string>) =>
    Effect.forEach(cwds, (cwd) => git.listLocalBranchNames(cwd), {
      concurrency: REPOSITORY_CONCURRENCY,
    });
  // Git stores branches as files, so a name also collides with one it nests under or contains.
  const collides = (existing: string, candidate: string) =>
    existing === candidate ||
    existing.startsWith(`${candidate}/`) ||
    candidate.startsWith(`${existing}/`);

  const freeBranchName = (
    operation: TaskFolderError["operation"],
    branch: string,
    names: ReadonlyArray<ReadonlyArray<string>>,
  ) => {
    for (let attempt = 1; attempt <= BRANCH_NAME_ATTEMPTS; attempt++) {
      const candidate = attempt === 1 ? branch : `${branch}-${attempt}`;
      if (!names.some((list) => list.some((existing) => collides(existing, candidate))))
        return Effect.succeed(candidate);
    }
    return Effect.fail(
      new TaskFolderError({
        operation,
        detail: `No branch name based on "${branch}" is free in every repository.`,
      }),
    );
  };

  /**
   * Where a repository's branch starts: `baseBranch` when the repository has it, else its
   * default branch. The remote commit of either when starting from origin.
   */
  const repositoryStart = Effect.fn("TaskFolders.repositoryStart")(function* (
    cwd: string,
    startFromOrigin: boolean,
    baseBranch?: string,
  ) {
    // Clients send `HEAD` when no base was chosen; as a name it would match `origin/HEAD`.
    const wanted = baseBranch?.replace(/^refs\/heads\//, "").replace(/^origin\//, "");
    const defaultBranch =
      wanted !== undefined &&
      wanted !== "" &&
      wanted !== "HEAD" &&
      ((yield* git.hasCommit({ cwd, refName: `refs/heads/${wanted}` })) ||
        (yield* git.hasCommit({ cwd, refName: `refs/remotes/origin/${wanted}` })))
        ? wanted
        : ((yield* gitDriver.resolveDefaultBranchName(cwd, "origin")) ??
          (yield* git.currentBranch(cwd)));
    let baseRef = "HEAD";
    if (defaultBranch !== null) {
      if (yield* git.hasCommit({ cwd, refName: `refs/heads/${defaultBranch}` }))
        baseRef = defaultBranch;
      else if (yield* git.hasCommit({ cwd, refName: `refs/remotes/origin/${defaultBranch}` }))
        baseRef = `origin/${defaultBranch}`;
    }
    const remoteBase =
      startFromOrigin && baseRef !== "HEAD"
        ? yield* git.fetchWorktreeBaseCommit({ cwd, refName: baseRef })
        : null;
    return remoteBase === null
      ? { refName: baseRef, baseRefName: baseRef }
      : { refName: remoteBase.commitSha, baseRefName: `refs/remotes/${remoteBase.remoteRefName}` };
  });

  /**
   * Stands in for a folder that is not a repository: every entry links to the original, so
   * nothing is copied, except the folders that lead to a tracked repository, which are real so a
   * worktree can sit in them.
   */
  const linkFolder: (
    source: string,
    target: string,
    trackedRepositories: ReadonlyArray<string>,
    skip?: string,
  ) => Effect.Effect<void, PlatformError.PlatformError> = Effect.fnUntraced(
    function* (source, target, trackedRepositories, skip) {
      yield* fileSystem.makeDirectory(target, { recursive: true });
      for (const name of yield* fileSystem.readDirectory(source)) {
        const entry = path.join(source, name);
        const link = path.join(target, name);
        if (name === ".git" || name === skip || trackedRepositories.includes(entry)) continue;
        if (yield* exists(link)) continue;
        if (trackedRepositories.some((repository) => isWithinRoot(path, repository, entry))) {
          yield* linkFolder(entry, link, trackedRepositories);
        } else {
          yield* fileSystem.symlink(entry, link);
        }
      }
    },
  );

  /**
   * Makes room for a worktree at `relative` inside a linked folder: a link on the way becomes a
   * real folder linking its other entries. Anything there that this service did not link stays.
   */
  const openLinkedPath = Effect.fnUntraced(function* (
    source: string,
    target: string,
    relative: string,
  ) {
    const segments = relative.split(path.sep);
    for (const [index, segment] of segments.entries()) {
      source = path.join(source, segment);
      target = path.join(target, segment);
      const last = index === segments.length - 1;
      const link = yield* fileSystem.readLink(target).pipe(Effect.option);
      if (Option.isSome(link)) {
        if (path.resolve(path.dirname(target), link.value) !== source) return false;
        yield* fileSystem.remove(target);
        if (!last) yield* linkFolder(source, target, [], segments[index + 1]);
      } else if (!last) {
        yield* fileSystem.makeDirectory(target, { recursive: true });
      }
    }
    return true;
  });

  /** Unlinks links and removes the folders that leaves empty; files and checkouts stay. */
  const removeLinks: (
    target: string,
  ) => Effect.Effect<boolean, PlatformError.PlatformError | RemoveEmptyDirectoryError> =
    Effect.fnUntraced(function* (target) {
      if (Option.isSome(yield* fileSystem.readLink(target).pipe(Effect.option))) {
        yield* fileSystem.remove(target);
        return true;
      }
      if (!(yield* exists(target))) return true;
      if ((yield* fileSystem.stat(target)).type !== "Directory") return false;
      if (yield* isRepository(target)) return false;
      let empty = true;
      for (const name of yield* fileSystem.readDirectory(target)) {
        if (!(yield* removeLinks(path.join(target, name)))) empty = false;
      }
      return empty && (yield* removeEmptyDirectory(target));
    });

  /** Whether `removeLinks` would leave nothing: only links and folders of links are inside. */
  const holdsOnlyLinks: (target: string) => Effect.Effect<boolean, PlatformError.PlatformError> =
    Effect.fnUntraced(function* (target) {
      if (Option.isSome(yield* fileSystem.readLink(target).pipe(Effect.option))) return true;
      if (!(yield* exists(target))) return true;
      if ((yield* fileSystem.stat(target)).type !== "Directory") return false;
      if (yield* isRepository(target)) return false;
      for (const name of yield* fileSystem.readDirectory(target)) {
        if (!(yield* holdsOnlyLinks(path.join(target, name)))) return false;
      }
      return true;
    });

  const allocateRoot = Effect.fn("TaskFolders.allocateRoot")(function* (
    taskPlan: TaskFolderPlan,
    branch: string,
  ) {
    const parent = resolveWorktreesDirectory(
      (yield* settings.getSettings.pipe(Effect.orElseSucceed(() => ({ worktreesDirectory: "" }))))
        .worktreesDirectory,
      config.worktreesDir,
      path,
      yield* HostProcess.HomeDirectory,
    );
    if (parent === null) {
      return yield* new TaskFolderError({
        operation: "create",
        detail:
          "The worktree location must be an absolute folder on this machine, not a drive root. Change it in Settings → Worktrees.",
      });
    }
    const hash = yield* digest.digest(
      Digest.sha256,
      new TextEncoder().encode(`${taskPlan.projectId}\0${taskPlan.anchor}\0${branch}`),
    );
    // UTF-8 bytes bound UTF-16 length too, leaving room for files on Windows.
    let prefix = "";
    for (const character of branch.replace(/\//g, "-")) {
      if (Buffer.byteLength(prefix + character) > 23) break;
      prefix += character;
    }
    const base = path.join(
      parent,
      path.basename(taskPlan.anchor) || "workspace",
      `${prefix}-${Hex.encode(hash).slice(0, 16)}`,
    );
    const allocateFailed = fail("create", "Could not create the worktree folder");
    yield* fileSystem
      .makeDirectory(path.dirname(base), { recursive: true })
      .pipe(Effect.mapError(allocateFailed));
    // Made here, not just found free: two creations on one branch must not share a folder.
    for (let suffix = 1; ; suffix++) {
      const root = suffix === 1 ? base : `${base}-${suffix}`;
      const claimed = yield* fileSystem.makeDirectory(root).pipe(
        Effect.as(true),
        Effect.catchIf(
          (cause) => cause.reason._tag === "AlreadyExists",
          () => Effect.succeed(false),
        ),
        Effect.mapError(allocateFailed),
      );
      if (claimed) return root;
    }
  });

  const removeCheckout = Effect.fnUntraced(function* (
    checkout: TaskFolderCheckout,
    force: boolean,
    deleteBranch: string | undefined,
  ) {
    yield* git.removeWorktree({
      cwd: checkout.repositoryPath,
      path: checkout.worktreePath,
      force,
    });
    if (deleteBranch !== undefined) {
      yield* git
        .deleteLocalBranch({ cwd: checkout.repositoryPath, refName: deleteBranch, force: true })
        .pipe(Effect.ignoreCause({ log: true }));
    }
  });

  const removeLocked = Effect.fn("TaskFolders.remove")(function* (
    taskFolder: TaskFolder,
    input: Omit<Parameters<TaskFolders["Service"]["remove"]>[0], "root">,
    /** Repositories whose `deleteBranch` is not this folder's to delete. */
    keepBranchIn: ReadonlySet<string> = new Set(),
    /** False when the folder never got as far as its layout command: nothing to tear down. */
    laidOut = true,
  ) {
    const removed: string[] = [];
    const kept: Array<{ path: string; reason: string }> = [];
    let remaining = taskFolder.repositories;
    const verdicts = new Map<string, { readonly keep: string | null; readonly force: boolean }>();
    const verdict = Effect.fnUntraced(function* (checkout: TaskFolderCheckout) {
      const known = verdicts.get(checkout.worktreePath);
      if (known !== undefined) return known;
      const decided =
        input.inspect === undefined
          ? { keep: null, force: input.force }
          : yield* input.inspect(checkout);
      verdicts.set(checkout.worktreePath, decided);
      return decided;
    });
    // The project's own teardown goes first; what it leaves is removed below as usual. Only when
    // every checkout may go: the command cannot be told which ones to keep.
    const layout = laidOut ? yield* worktreeLayout(taskFolder.projectRoot) : null;
    if (layout?.remove !== undefined) {
      const checkouts = [
        ...taskFolder.repositories,
        ...(taskFolder.projectIsWorktree
          ? [{ worktreePath: taskFolder.projectPath, repositoryPath: taskFolder.projectRoot }]
          : []),
      ];
      let allGo = true;
      for (const checkout of checkouts) {
        if (!(yield* exists(checkout.worktreePath))) continue;
        if ((yield* verdict(checkout)).keep === null) continue;
        allGo = false;
        break;
      }
      if (allGo) {
        yield* runLayoutCommand(
          "remove",
          layout.remove,
          taskFolder,
          input.deleteBranch ?? "",
          undefined,
          taskFolder.repositories.map((repository) => repository.repositoryPath),
        ).pipe(Effect.ignoreCause({ log: true }));
        // The command took its time: what it left is looked at again before it is removed.
        verdicts.clear();
      }
    }
    const removeOne = Effect.fnUntraced(function* (checkout: TaskFolderCheckout) {
      if (!(yield* exists(checkout.worktreePath))) {
        yield* git
          .pruneWorktrees({ cwd: checkout.repositoryPath })
          .pipe(Effect.ignoreCause({ log: true }));
        return true;
      }
      const { keep, force } = yield* verdict(checkout);
      if (keep !== null) {
        kept.push({ path: checkout.worktreePath, reason: keep });
        return false;
      }
      return yield* removeCheckout(
        checkout,
        force,
        keepBranchIn.has(checkout.repositoryPath) ? undefined : input.deleteBranch,
      ).pipe(
        Effect.as(true),
        Effect.tap(() => Effect.sync(() => removed.push(checkout.worktreePath))),
        Effect.catch((cause) =>
          Effect.sync(() => {
            kept.push({ path: checkout.worktreePath, reason: failureDetail(cause) });
            return false;
          }),
        ),
      );
    });
    // Children first: a worktree nested in another must go before the one that holds it.
    for (const repository of taskFolder.repositories.toSorted(
      (left, right) => depth(right.worktreePath) - depth(left.worktreePath),
    )) {
      const holdsKept = kept.some((entry) =>
        isWithinRoot(path, entry.path, repository.worktreePath),
      );
      if (holdsKept) {
        kept.push({ path: repository.worktreePath, reason: "holds a repository that was kept" });
        continue;
      }
      if (!(yield* removeOne(repository))) continue;
      remaining = remaining.filter((entry) => entry.worktreePath !== repository.worktreePath);
      // After each one, so a crash leaves a record that matches the disk.
      if (input.forget) yield* store.put({ ...taskFolder, repositories: remaining });
    }
    const projectPath = taskFolder.projectPath;
    const projectHoldsKept = kept.some((entry) => isWithinRoot(path, entry.path, projectPath));
    let projectGone = false;
    if (taskFolder.projectIsWorktree) {
      if (projectHoldsKept) {
        if (yield* exists(projectPath))
          kept.push({ path: projectPath, reason: "holds a repository that was kept" });
      } else {
        projectGone = yield* removeOne({
          worktreePath: projectPath,
          repositoryPath: taskFolder.projectRoot,
        });
      }
    } else if (!projectHoldsKept) {
      // A folder that stays keeps its links: restoring relinks only a folder that is gone.
      projectGone = yield* holdsOnlyLinks(projectPath).pipe(
        Effect.flatMap((onlyLinks) =>
          onlyLinks ? removeLinks(projectPath) : Effect.succeed(false),
        ),
        Effect.orElseSucceed(() => false),
      );
      if (!projectGone && input.force && input.inspect === undefined) {
        // Forced: what is left are files the thread wrote beside the links.
        projectGone = yield* fileSystem.remove(projectPath, { recursive: true, force: true }).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
      }
      if (projectGone) removed.push(projectPath);
      else kept.push({ path: projectPath, reason: "has files that exist only in this folder" });
    }
    if (kept.length === 0) {
      let rootGone = yield* removeLinks(taskFolder.root).pipe(Effect.orElseSucceed(() => false));
      if (!rootGone && input.force && input.inspect === undefined) {
        rootGone = yield* fileSystem.remove(taskFolder.root, { recursive: true, force: true }).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
      }
      if (!rootGone) {
        kept.push({ path: taskFolder.root, reason: "has files that exist only in this folder" });
      } else if (input.forget) yield* store.remove(taskFolder.root);
    }
    return { removed, kept } satisfies TaskFolderRemoval;
  });

  const requireTaskFolder = Effect.fnUntraced(function* (
    operation: TaskFolderError["operation"],
    target: string,
  ) {
    const taskFolder = yield* store.findContaining(target);
    if (taskFolder === null) {
      return yield* new TaskFolderError({
        operation,
        detail: `"${target}" is not inside a task folder.`,
      });
    }
    return taskFolder;
  });
  // The same lease storage cleanup and file rewind take: the thread's worktree path.
  const locked = <A, E>(taskFolder: Pick<TaskFolder, "projectPath">, effect: Effect.Effect<A, E>) =>
    withWorkspaceLease(path.resolve(taskFolder.projectPath), effect);

  const createRepositoryWorktree = Effect.fnUntraced(function* (
    taskFolder: TaskFolder,
    repository: ProjectTrackedFolder,
    branch: string,
    startFromOrigin: boolean,
    baseBranch: string | undefined,
  ) {
    const worktreePath = mapped(taskFolder, repository.path);
    // The project's own checkout (a post-checkout hook, say) already provided this repository.
    // A link counts even to an empty folder: Git would write the worktree through it.
    if (
      Option.isSome(yield* fileSystem.readLink(worktreePath).pipe(Effect.option)) ||
      (yield* occupied(worktreePath))
    )
      return null;
    yield* fileSystem.makeDirectory(path.dirname(worktreePath), { recursive: true });
    const start = yield* repositoryStart(repository.path, startFromOrigin, baseBranch);
    yield* git.createWorktree({
      cwd: repository.path,
      refName: start.refName,
      newRefName: branch,
      baseRefName: start.baseRefName,
      path: worktreePath,
    });
    return {
      repository: {
        repositoryPath: repository.path,
        worktreePath,
        name: repository.name,
      } satisfies TaskFolderRepository,
      fromOrigin: start.refName !== start.baseRefName,
    };
  });

  const create: TaskFolders["Service"]["create"] = Effect.fn("TaskFolders.create")(
    function* (input) {
      const taskPlan = input.plan;
      const listFailed = fail("create", "Could not list branches");
      const names = yield* branchNames(
        taskPlan.repositories.map((repository) => repository.path),
      ).pipe(Effect.mapError(listFailed));
      const projectNames = taskPlan.projectIsRepository
        ? yield* git.listLocalBranchNames(taskPlan.projectRoot).pipe(Effect.mapError(listFailed))
        : [];
      // A temporary name nests under its prefix, which a repository may hold as a branch.
      const requested =
        isTemporaryWorktreeBranch(input.branch) &&
        [...names, projectNames].some((list) =>
          list.some((existing) => input.branch.startsWith(`${existing}/`)),
        )
          ? flattenTemporaryWorktreeBranchName(input.branch)
          : input.branch;
      // A name the project folder already has is Git's to refuse, as for a single worktree.
      const branch = projectNames.some((existing) => collides(existing, requested))
        ? requested
        : yield* freeBranchName("create", requested, [...names, projectNames]);
      const root = yield* allocateRoot(taskPlan, branch);
      const empty: TaskFolder = {
        root,
        projectId: taskPlan.projectId,
        projectRoot: taskPlan.projectRoot,
        anchor: taskPlan.anchor,
        projectPath: path.join(root, path.relative(taskPlan.anchor, taskPlan.projectRoot)),
        projectIsWorktree: taskPlan.projectIsRepository,
        repositories: [],
      };
      const created: TaskFolderRepository[] = [];
      let repositoriesStartedFromOrigin = false;
      const current = (): TaskFolder => ({ ...empty, repositories: [...created] });
      const checkedOutFrom = [
        ...(taskPlan.projectIsRepository ? [taskPlan.projectRoot] : []),
        ...taskPlan.trackedRepositories,
      ];
      // A layout command may check out a branch that was already there; a rollback leaves it.
      const hadBranch = new Set<string>();
      let layoutStarted = false;
      // Where this attempt makes the branch: a checkout that fails halfway leaves it behind.
      let branchMadeIn = [
        ...taskPlan.repositories
          .filter((_, index) => !names[index]!.includes(branch))
          .map((repository) => repository.path),
        ...(taskPlan.projectIsRepository && !projectNames.includes(branch)
          ? [taskPlan.projectRoot]
          : []),
      ];
      return yield* Effect.gen(function* () {
        yield* fileSystem.makeDirectory(root, { recursive: true });
        // Recorded before any checkout, so an interrupted creation is still found and removed.
        yield* store.put(empty);
        if (input.onClaimed !== undefined) yield* input.onClaimed(empty, branch);
        const layout = yield* worktreeLayout(taskPlan.projectRoot);
        if (layout !== null) {
          const before = yield* branchNames(checkedOutFrom).pipe(Effect.mapError(listFailed));
          for (const [index, repositoryPath] of checkedOutFrom.entries()) {
            if (before[index]!.includes(branch)) hadBranch.add(repositoryPath);
          }
          branchMadeIn = checkedOutFrom.filter((repositoryPath) => !hadBranch.has(repositoryPath));
          layoutStarted = true;
          const ran = yield* Effect.exit(
            runLayoutCommand(
              "create",
              layout.create,
              empty,
              branch,
              input.baseBranch,
              taskPlan.repositories.map((repository) => repository.path),
            ),
          );
          // Whatever the command checked out where a repository belongs is the thread's. Adopted
          // even when the command failed, so the rollback removes it instead of leaking it.
          const refused: string[] = [];
          for (const repositoryPath of taskPlan.trackedRepositories) {
            const checkout = { repositoryPath, worktreePath: mapped(empty, repositoryPath) };
            if (!(yield* isRepository(checkout.worktreePath))) continue;
            const reason = yield* unadoptable(checkout, branch);
            if (reason === null) created.push({ ...checkout, name: path.basename(repositoryPath) });
            else refused.push(reason);
          }
          if (Exit.isFailure(ran)) return yield* Effect.failCause(ran.cause);
          if (!(yield* exists(empty.projectPath))) {
            return yield* new TaskFolderError({
              operation: "create",
              detail: `The project's worktree layout command left no folder at ${empty.projectPath}.`,
            });
          }
          if (taskPlan.projectIsRepository && (yield* isRepository(empty.projectPath))) {
            const reason = yield* unadoptable(
              { repositoryPath: taskPlan.projectRoot, worktreePath: empty.projectPath },
              branch,
            );
            if (reason !== null) refused.push(reason);
          }
          if (refused.length > 0) {
            return yield* new TaskFolderError({
              operation: "create",
              detail: `The project's worktree layout command must make each checkout with git worktree add on the thread's branch: ${refused.join("; ")}.`,
            });
          }
          const taskFolder: TaskFolder = {
            ...current(),
            projectIsWorktree:
              taskPlan.projectIsRepository && (yield* isRepository(empty.projectPath)),
          };
          yield* store.put(taskFolder);
          return {
            taskFolder,
            branch,
            laidOutByProject: true,
            repositoriesStartedFromOrigin: false,
          };
        }
        if (taskPlan.projectIsRepository) {
          yield* fileSystem.makeDirectory(path.dirname(empty.projectPath), { recursive: true });
          yield* git.createWorktree(
            {
              cwd: taskPlan.projectRoot,
              refName: input.projectStart.refName,
              newRefName: branch,
              baseRefName: input.projectStart.baseRefName,
              path: empty.projectPath,
            },
            input.projectProgress === undefined ? {} : { progress: input.projectProgress },
          );
        } else {
          yield* linkFolder(taskPlan.projectRoot, empty.projectPath, taskPlan.trackedRepositories);
        }
        let finished = 0;
        // Whatever the project put at a skipped path also stands for the repositories inside it.
        const skipped: string[] = [];
        // A repository inside another waits for the one that holds it.
        const levels = Map.groupBy(
          taskPlan.repositories,
          (repository) =>
            taskPlan.repositories.filter(
              (other) =>
                other.path !== repository.path && isWithinRoot(path, repository.path, other.path),
            ).length,
        );
        for (const level of [...levels.keys()].toSorted((left, right) => left - right)) {
          // Every checkout runs to its end: one stopped halfway is registered in its repository
          // without being known here, so nothing would remove it.
          const exits = yield* Effect.forEach(
            levels.get(level)!,
            (repository) =>
              (skipped.some((outer) => isWithinRoot(path, repository.path, outer))
                ? Effect.succeed(null)
                : createRepositoryWorktree(
                    empty,
                    repository,
                    branch,
                    input.startFromOrigin,
                    input.baseBranch,
                  )
              ).pipe(
                Effect.tap((worktree) =>
                  Effect.suspend(() => {
                    finished += 1;
                    if (worktree === null) skipped.push(repository.path);
                    else {
                      created.push(worktree.repository);
                      repositoriesStartedFromOrigin ||= worktree.fromOrigin;
                    }
                    return (
                      input.onRepository?.({
                        name: repository.name,
                        done: finished,
                        total: taskPlan.repositories.length,
                      }) ?? Effect.void
                    );
                  }),
                ),
                Effect.mapError(fail("create", `Could not create the ${repository.name} worktree`)),
                Effect.exit,
              ),
            { concurrency: REPOSITORY_CONCURRENCY },
          ).pipe(Effect.uninterruptible);
          const failed = exits.find(Exit.isFailure);
          if (failed !== undefined) return yield* Effect.failCause(failed.cause);
        }
        const taskFolder = current();
        yield* store.put(taskFolder);
        return { taskFolder, branch, laidOutByProject: false, repositoriesStartedFromOrigin };
      }).pipe(
        Effect.onError(() =>
          // Recorded first: a checkout the rollback cannot remove must still be known afterwards.
          store.put(current()).pipe(
            Effect.ignoreCause({ log: true }),
            Effect.andThen(
              removeLocked(
                current(),
                { force: true, forget: true, deleteBranch: branch },
                hadBranch,
                layoutStarted,
              ),
            ),
            Effect.tap(({ kept }) =>
              kept.length === 0
                ? Effect.void
                : Effect.logWarning("A failed task folder was not fully removed", { root, kept }),
            ),
            Effect.ignoreCause({ log: true }),
            // A checkout the layout command made and this service refused was deleted as files.
            Effect.andThen(
              Effect.forEach(
                checkedOutFrom,
                (cwd) => git.pruneWorktrees({ cwd }).pipe(Effect.ignoreCause({ log: true })),
                { concurrency: REPOSITORY_CONCURRENCY, discard: true },
              ),
            ),
            // Only now that no checkout is registered on it; most went with their checkout.
            Effect.andThen(
              Effect.forEach(
                branchMadeIn,
                (cwd) =>
                  git.deleteLocalBranch({ cwd, refName: branch, force: true }).pipe(Effect.ignore),
                { concurrency: REPOSITORY_CONCURRENCY, discard: true },
              ),
            ),
          ),
        ),
        Effect.mapError((cause) =>
          isTaskFolderError(cause)
            ? cause
            : fail("create", "Could not create the worktrees")(cause),
        ),
      );
    },
  );

  /** The project's setting for where new worktrees start. */
  const startsFromOrigin = (operation: TaskFolderError["operation"], projectId: ProjectId) =>
    settings.getSettings.pipe(
      Effect.mapError(fail(operation, "Could not read settings")),
      Effect.map(
        (current) =>
          resolveProjectSettings(current, projectId).settings.newWorktreesStartFromOrigin,
      ),
    );

  const createForProjectFolder: TaskFolders["Service"]["createForProjectFolder"] = Effect.fn(
    "TaskFolders.createForProjectFolder",
  )(function* (input) {
    if (input.path !== null || input.newRefName === undefined) return null;
    const project = yield* projects
      .findActiveByWorkspaceRoot(input.cwd)
      .pipe(Effect.mapError(fail("plan", "Could not read the project")));
    if (Option.isNone(project)) return null;
    const { projectId } = project.value;
    const taskPlan = yield* plan({ projectId });
    if (taskPlan === null) return null;
    const { taskFolder, branch } = yield* create({
      plan: taskPlan,
      branch: input.newRefName,
      projectStart: { refName: input.refName, baseRefName: input.baseRefName ?? input.refName },
      baseBranch: input.baseRefName ?? input.refName,
      startFromOrigin: yield* startsFromOrigin("create", projectId),
    });
    return { worktree: { path: taskFolder.projectPath, refName: branch } };
  });

  const addRepository: TaskFolders["Service"]["addRepository"] = Effect.fn(
    "TaskFolders.addRepository",
  )(function* (input) {
    const refuse = (detail: string) => new TaskFolderError({ operation: "add-repository", detail });
    const thread = yield* projections
      .getThreadShell(input.threadId)
      .pipe(Effect.mapError(fail("add-repository", "Could not read the thread")));
    if (thread === null || thread.worktreePath === null || thread.branch === null)
      return yield* refuse("This thread does not work in a worktree.");
    const recordedBranch = thread.branch;
    const startFromOrigin =
      input.startFromOrigin ?? (yield* startsFromOrigin("add-repository", thread.projectId));
    const found = yield* requireTaskFolder("add-repository", thread.worktreePath);
    return yield* locked(
      found,
      Effect.gen(function* () {
        // Read again under the lease: another add may have landed.
        const taskFolder = yield* requireTaskFolder("add-repository", found.root);
        // The thread's record lags a rename of its branch, so a checkout says which one it is.
        const checkedOut = taskFolder.projectIsWorktree
          ? taskFolder.projectPath
          : taskFolder.repositories[0]?.worktreePath;
        const branch =
          (checkedOut === undefined
            ? null
            : yield* git.currentBranch(checkedOut).pipe(Effect.orElseSucceed(() => null))) ??
          recordedBranch;
        const project = yield* readProject("add-repository", taskFolder.projectId);
        const repositoryPath = path.resolve(input.repositoryPath);
        const folder = (yield* trackedFolders(project)).find(
          (candidate) => path.resolve(candidate.path) === repositoryPath,
        );
        if (folder === undefined)
          return yield* refuse(`"${input.repositoryPath}" is not a tracked folder of the project.`);
        if (!(yield* isRepository(repositoryPath)))
          return yield* refuse(`"${input.repositoryPath}" is not a Git repository.`);
        if (yield* isSubmodule(repositoryPath))
          return yield* refuse(`${folder.name} is a submodule, so it comes with its repository.`);
        if (taskFolder.repositories.some((entry) => entry.repositoryPath === repositoryPath))
          return yield* refuse(`${folder.name} already has a worktree in this thread.`);
        if (!isWithinRoot(path, repositoryPath, taskFolder.anchor))
          return yield* refuse(
            `${folder.name} lies outside the folders this thread's worktree was laid out for. Start a new worktree thread to include it.`,
          );
        const worktreePath = mapped(taskFolder, repositoryPath);
        const insideLinkedProject =
          !taskFolder.projectIsWorktree &&
          isWithinRoot(path, repositoryPath, taskFolder.projectRoot) &&
          repositoryPath !== taskFolder.projectRoot;
        const wasLinked =
          insideLinkedProject &&
          Option.isSome(yield* fileSystem.readLink(worktreePath).pipe(Effect.option));
        const opened = insideLinkedProject
          ? yield* openLinkedPath(
              taskFolder.projectRoot,
              taskFolder.projectPath,
              path.relative(taskFolder.projectRoot, repositoryPath),
            ).pipe(Effect.mapError(fail("add-repository", "Could not prepare the folder")))
          : true;
        if (!opened || (yield* occupied(worktreePath)))
          return yield* refuse(`${worktreePath} already holds files, so no worktree can go there.`);
        // The link the worktree took the place of comes back when the worktree does not stay.
        const relink = wasLinked
          ? // Git may or may not have left an empty folder where the link was.
            removeEmptyDirectory(worktreePath).pipe(
              Effect.ignore,
              Effect.andThen(fileSystem.symlink(repositoryPath, worktreePath)),
              Effect.ignoreCause({ log: true }),
            )
          : Effect.void;
        const existing = (yield* git
          .listLocalBranchNames(repositoryPath)
          .pipe(Effect.mapError(fail("add-repository", "Could not list branches")))).includes(
          branch,
        );
        yield* Effect.gen(function* () {
          yield* fileSystem.makeDirectory(path.dirname(worktreePath), { recursive: true });
          if (existing) {
            // The thread's branch is already there, so it is checked out, not started again.
            yield* git.createWorktree({
              cwd: repositoryPath,
              refName: branch,
              path: worktreePath,
            });
          } else {
            const start = yield* repositoryStart(repositoryPath, startFromOrigin);
            yield* git.createWorktree({
              cwd: repositoryPath,
              refName: start.refName,
              newRefName: branch,
              baseRefName: start.baseRefName,
              path: worktreePath,
            });
          }
        }).pipe(
          Effect.onError(() => relink),
          Effect.mapError(fail("add-repository", `Could not create the ${folder.name} worktree`)),
        );
        const updated: TaskFolder = {
          ...taskFolder,
          repositories: [
            ...taskFolder.repositories,
            { repositoryPath, worktreePath, name: folder.name },
          ],
        };
        yield* store
          .put(updated)
          .pipe(
            Effect.onError(() =>
              removeCheckout(
                { repositoryPath, worktreePath },
                true,
                existing ? undefined : branch,
              ).pipe(Effect.ignoreCause({ log: true }), Effect.andThen(relink)),
            ),
          );
        return updated;
      }),
    );
  });

  const remove: TaskFolders["Service"]["remove"] = Effect.fnUntraced(function* (input) {
    const taskFolder = yield* store.findContaining(input.root);
    if (taskFolder === null || taskFolder.root !== input.root) return { removed: [], kept: [] };
    return yield* removeLocked(taskFolder, input);
  });

  const removeIfTaskFolder: TaskFolders["Service"]["removeIfTaskFolder"] = Effect.fn(
    "TaskFolders.removeIfTaskFolder",
  )(function* (input) {
    const taskFolder = yield* store.findContaining(input.path);
    const target = path.resolve(input.path);
    if (taskFolder === null || (target !== taskFolder.root && target !== taskFolder.projectPath))
      return false;
    const { kept } = yield* removeLocked(taskFolder, { force: input.force, forget: true });
    if (kept.length > 0) {
      return yield* new TaskFolderError({
        operation: "remove",
        detail: `Kept ${kept.map((entry) => `${entry.path} (${entry.reason})`).join(", ")}.`,
      });
    }
    return true;
  });

  const renameBranch: TaskFolders["Service"]["renameBranch"] = Effect.fn(
    "TaskFolders.renameBranch",
  )(function* (input) {
    const taskFolder = yield* requireTaskFolder("create", input.root);
    const cwds = [
      ...(taskFolder.projectIsWorktree ? [taskFolder.projectPath] : []),
      ...taskFolder.repositories.map((repository) => repository.worktreePath),
    ];
    if (cwds.length === 0 || input.oldBranch === input.newBranch)
      return { branch: input.oldBranch };
    const renameFailed = fail("create", "Could not rename the branch");
    const branch =
      input.exactName === true
        ? input.newBranch
        : yield* freeBranchName(
            "create",
            input.newBranch,
            (yield* branchNames(cwds).pipe(Effect.mapError(renameFailed))).map((list) =>
              list.filter((existing) => existing !== input.oldBranch),
            ),
          );
    const renamed: string[] = [];
    yield* Effect.forEach(
      cwds,
      (cwd) =>
        git
          .renameBranch({ cwd, oldBranch: input.oldBranch, newBranch: branch, exactName: true })
          .pipe(Effect.tap(() => Effect.sync(() => renamed.push(cwd)))),
      { discard: true },
    ).pipe(
      // One name everywhere or the old one everywhere.
      Effect.onError(() =>
        Effect.forEach(
          renamed,
          (cwd) =>
            git
              .renameBranch({ cwd, oldBranch: branch, newBranch: input.oldBranch, exactName: true })
              .pipe(Effect.ignoreCause({ log: true })),
          { discard: true },
        ),
      ),
      Effect.mapError(renameFailed),
    );
    return { branch };
  });

  const restore: TaskFolders["Service"]["restore"] = Effect.fn("TaskFolders.restore")(function* ({
    taskFolder,
    branch,
    recreate,
  }) {
    const restoreFailed = fail("create", "Could not restore the worktrees");
    // A project that lays its own folder out rebuilds it; whatever is still missing after that
    // comes back as a plain checkout below.
    const layout = yield* worktreeLayout(taskFolder.projectRoot);
    const present = yield* Effect.forEach(
      [taskFolder.projectPath, ...taskFolder.repositories.map((entry) => entry.worktreePath)],
      exists,
    );
    if (layout !== null && present.includes(false)) {
      yield* fileSystem
        .makeDirectory(taskFolder.root, { recursive: true })
        .pipe(Effect.mapError(restoreFailed));
      yield* runLayoutCommand(
        "create",
        layout.create,
        taskFolder,
        branch,
        undefined,
        taskFolder.repositories.map((repository) => repository.repositoryPath),
      ).pipe(Effect.ignoreCause({ log: true }));
    }
    const recreateMissing = Effect.fnUntraced(function* (checkout: TaskFolderCheckout) {
      if (yield* isRepository(checkout.worktreePath)) {
        // Another checkout in its place is not the thread's: resuming there would work on it.
        if ((yield* linkedGitDir(checkout)) !== null) return;
        return yield* new TaskFolderError({
          operation: "create",
          detail: `${checkout.worktreePath} holds a checkout that is not a worktree of ${checkout.repositoryPath}. Move it away to restore the thread's worktree.`,
        });
      }
      yield* fileSystem
        .makeDirectory(path.dirname(checkout.worktreePath), { recursive: true })
        .pipe(Effect.mapError(restoreFailed));
      yield* recreate(checkout);
    });
    if (taskFolder.projectIsWorktree) {
      yield* recreateMissing({
        worktreePath: taskFolder.projectPath,
        repositoryPath: taskFolder.projectRoot,
      });
    } else if (!(yield* exists(taskFolder.projectPath))) {
      const project = yield* readProject("create", taskFolder.projectId);
      const tracked = yield* Effect.filter(
        (yield* trackedFolders(project)).map((folder) => path.resolve(folder.path)),
        isRepository,
      );
      // A recorded repository the project no longer tracks still gets its worktree, never a link.
      yield* linkFolder(taskFolder.projectRoot, taskFolder.projectPath, [
        ...tracked,
        ...taskFolder.repositories.map((repository) => repository.repositoryPath),
      ]).pipe(Effect.mapError(restoreFailed));
    }
    for (const repository of taskFolder.repositories.toSorted(
      (left, right) => depth(left.worktreePath) - depth(right.worktreePath),
    )) {
      yield* recreateMissing(repository);
    }
  });

  return TaskFolders.of({
    plan,
    create,
    createForProjectFolder,
    addRepository,
    find: store.findContaining,
    remove,
    removeIfTaskFolder,
    renameBranch,
    restore,
  });
});

export const layer = Layer.effect(TaskFolders, make);
