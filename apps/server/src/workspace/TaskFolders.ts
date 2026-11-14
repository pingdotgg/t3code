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
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { flattenTemporaryWorktreeBranchName, isTemporaryWorktreeBranch } from "@t3tools/shared/git";
import * as HostProcess from "@t3tools/shared/HostProcess";
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
import {
  removeEmptyDirectory,
  type RemoveEmptyDirectoryError,
} from "../vcs/removeEmptyDirectory.ts";
import { resolveWorktreesDirectory } from "../worktreesDirectory.ts";
import { isWithinRoot } from "./KnownWorkspaces.ts";
import * as TaskFolderStore from "./TaskFolderStore.ts";
import { withWorkspaceLease } from "./workspaceLease.ts";

// Each worktree is a checkout: enough at once to finish four repositories together, few enough
// to leave Git's server-wide process slots to running threads.
const REPOSITORY_CONCURRENCY = 4;
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
      { readonly taskFolder: TaskFolder; readonly branch: string },
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
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  const exists = (target: string) =>
    fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false));
  const isRepository = (folder: string) => exists(path.join(folder, ".git"));
  const fail =
    (operation: TaskFolderError["operation"], prefix: string) =>
    (cause: unknown): TaskFolderError =>
      new TaskFolderError({ operation, detail: `${prefix}: ${failureDetail(cause)}`, cause });

  const commonAncestor = (folders: ReadonlyArray<string>) => {
    let ancestor = folders[0]!;
    for (const folder of folders.slice(1)) {
      while (!isWithinRoot(path, folder, ancestor)) ancestor = path.dirname(ancestor);
    }
    return ancestor;
  };
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
      project.trackedFolders,
      (folder) => {
        const folderPath = path.resolve(folder.path);
        return isRepository(folderPath).pipe(
          Effect.map((git) => ({ name: folder.name, path: folderPath, git })),
        );
      },
      { concurrency: 8 },
    );
    const tracked = classified.filter((folder) => folder.git && folder.path !== projectRoot);
    if (tracked.length === 0) return null;
    let repositories: ReadonlyArray<ProjectTrackedFolder>;
    if (input.repositories === undefined) {
      repositories = tracked.length <= TASK_FOLDER_DEFAULT_REPOSITORIES_MAX ? tracked : [];
    } else {
      const selected = new Map<string, ProjectTrackedFolder>();
      for (const requested of input.repositories) {
        const requestedPath = path.resolve(requested.path);
        const folder = classified.find((candidate) => candidate.path === requestedPath);
        if (folder === undefined || !folder.git || folder.path === projectRoot) {
          return yield* new TaskFolderError({
            operation: "plan",
            detail:
              folder === undefined
                ? `"${requested.path}" is not a tracked folder of project "${project.title}".`
                : `"${requested.path}" is not a Git repository, so it cannot get a worktree.`,
          });
        }
        selected.set(folder.path, folder);
      }
      repositories = [...selected.values()];
    }
    return {
      projectId: project.projectId,
      projectRoot,
      projectIsRepository: yield* isRepository(projectRoot),
      anchor: commonAncestor([projectRoot, ...tracked.map((folder) => folder.path)]),
      repositories: repositories.map(({ name, path: folderPath }) => ({ name, path: folderPath })),
      trackedRepositories: tracked.map((folder) => folder.path),
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

  /** A repository's default branch, and the remote commit of it when starting from origin. */
  const repositoryStart = Effect.fn("TaskFolders.repositoryStart")(function* (
    cwd: string,
    startFromOrigin: boolean,
  ) {
    const defaultBranch =
      (yield* gitDriver.resolveDefaultBranchName(cwd, "origin")) ?? (yield* git.currentBranch(cwd));
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
    let root = base;
    for (let suffix = 2; yield* exists(root); suffix++) root = `${base}-${suffix}`;
    return root;
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
  ) {
    const removed: string[] = [];
    const kept: Array<{ path: string; reason: string }> = [];
    let remaining = taskFolder.repositories;
    const verdict = (checkout: TaskFolderCheckout) =>
      input.inspect === undefined
        ? Effect.succeed({ keep: null, force: input.force })
        : input.inspect(checkout);
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
      return yield* removeCheckout(checkout, force, input.deleteBranch).pipe(
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
    } else {
      projectGone = yield* removeLinks(projectPath).pipe(Effect.orElseSucceed(() => false));
      if (!projectGone && !projectHoldsKept && input.force && input.inspect === undefined) {
        // Forced: what is left are files the thread wrote beside the links.
        projectGone = yield* fileSystem.remove(projectPath, { recursive: true, force: true }).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
      }
      if (projectGone) removed.push(projectPath);
      else if (!projectHoldsKept)
        kept.push({ path: projectPath, reason: "has files that exist only in this folder" });
    }
    if (kept.length === 0) {
      yield* removeLinks(taskFolder.root).pipe(Effect.ignore);
      if (input.forget) yield* store.remove(taskFolder.root);
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
  ) {
    const worktreePath = mapped(taskFolder, repository.path);
    yield* fileSystem.makeDirectory(path.dirname(worktreePath), { recursive: true });
    const start = yield* repositoryStart(repository.path, startFromOrigin);
    yield* git.createWorktree({
      cwd: repository.path,
      refName: start.refName,
      newRefName: branch,
      baseRefName: start.baseRefName,
      path: worktreePath,
    });
    return {
      repositoryPath: repository.path,
      worktreePath,
      name: repository.name,
    } satisfies TaskFolderRepository;
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
      const current = (): TaskFolder => ({ ...empty, repositories: [...created] });
      return yield* Effect.gen(function* () {
        yield* fileSystem.makeDirectory(root, { recursive: true });
        // Recorded before any checkout, so an interrupted creation is still found and removed.
        yield* store.put(empty);
        if (input.onClaimed !== undefined) yield* input.onClaimed(empty, branch);
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
              createRepositoryWorktree(empty, repository, branch, input.startFromOrigin).pipe(
                Effect.tap((worktree) =>
                  Effect.suspend(() => {
                    created.push(worktree);
                    return (
                      input.onRepository?.({
                        name: repository.name,
                        done: created.length,
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
        return { taskFolder, branch };
      }).pipe(
        Effect.onError(() =>
          removeLocked(current(), { force: true, forget: true, deleteBranch: branch }).pipe(
            Effect.tap(({ kept }) =>
              kept.length === 0
                ? Effect.void
                : Effect.logWarning("A failed task folder was not fully removed", { root, kept }),
            ),
            Effect.ignoreCause({ log: true }),
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
    const branch = thread.branch;
    const startFromOrigin =
      input.startFromOrigin ?? (yield* startsFromOrigin("add-repository", thread.projectId));
    const found = yield* requireTaskFolder("add-repository", thread.worktreePath);
    return yield* locked(
      found,
      Effect.gen(function* () {
        // Read again under the lease: another add may have landed.
        const taskFolder = yield* requireTaskFolder("add-repository", found.root);
        const project = yield* readProject("add-repository", taskFolder.projectId);
        const repositoryPath = path.resolve(input.repositoryPath);
        const folder = project.trackedFolders.find(
          (candidate) => path.resolve(candidate.path) === repositoryPath,
        );
        if (folder === undefined)
          return yield* refuse(`"${input.repositoryPath}" is not a tracked folder of the project.`);
        if (!(yield* isRepository(repositoryPath)))
          return yield* refuse(`"${input.repositoryPath}" is not a Git repository.`);
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
        const opened = insideLinkedProject
          ? yield* openLinkedPath(
              taskFolder.projectRoot,
              taskFolder.projectPath,
              path.relative(taskFolder.projectRoot, repositoryPath),
            ).pipe(Effect.mapError(fail("add-repository", "Could not prepare the folder")))
          : true;
        const occupied =
          !opened ||
          ((yield* exists(worktreePath)) &&
            ((yield* fileSystem.stat(worktreePath).pipe(Effect.option)).pipe(
              Option.exists((info) => info.type !== "Directory"),
            ) ||
              (yield* fileSystem.readDirectory(worktreePath).pipe(Effect.orElseSucceed(() => [""])))
                .length > 0));
        if (occupied)
          return yield* refuse(`${worktreePath} already holds files, so no worktree can go there.`);
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
              ).pipe(Effect.ignoreCause({ log: true })),
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
    recreate,
  }) {
    const restoreFailed = fail("create", "Could not restore the worktrees");
    const recreateMissing = Effect.fnUntraced(function* (checkout: TaskFolderCheckout) {
      if (yield* isRepository(checkout.worktreePath)) return;
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
        project.trackedFolders.map((folder) => path.resolve(folder.path)),
        isRepository,
      );
      yield* linkFolder(taskFolder.projectRoot, taskFolder.projectPath, tracked).pipe(
        Effect.mapError(restoreFailed),
      );
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
