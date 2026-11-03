import {
  type GitCommandError,
  GitManagerError,
  type GitManagerServiceError,
  type GitPreparePullRequestThreadInput,
  type GitPreparePullRequestThreadResult,
  type OrchestrationV2LaunchRepository,
  type ProjectId,
  type ProjectTrackedFolder,
} from "@t3tools/contracts";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import {
  buildTemporaryWorktreeBranchName,
  flattenTemporaryWorktreeBranchName,
  isTemporaryWorktreeBranch,
  WORKTREE_BRANCH_PREFIX,
} from "@t3tools/shared/git";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { removeEmptyDirectory } from "../vcs/removeEmptyDirectory.ts";
import { isFilesystemRoot, resolveWorktreesDirectory } from "../worktreesDirectory.ts";
import {
  TaskFolderStore,
  type TaskFolderRecord,
  type TaskFolderRepositoryRow,
} from "./TaskFolders.ts";
import { WorkspaceRepositories } from "./WorkspaceRepositories.ts";

const GIT_CONCURRENCY = 4;

export class TaskFolderError extends Schema.TaggedError<TaskFolderError>()("TaskFolderError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

/** A tracked Git folder a new task folder would hold. */
export interface TaskFolderPlanRepository {
  readonly name: string;
  readonly originalPath: string;
  /** Overrides the repo's default branch. */
  readonly baseRef: string | undefined;
}

/** What "New worktree" creates in a project with tracked Git folders and a Git home. */
export interface TaskFolderPlan {
  readonly projectId: ProjectId;
  readonly homeName: string;
  readonly homePath: string;
  readonly repositories: ReadonlyArray<TaskFolderPlanRepository>;
}

export interface TaskFolderProject {
  readonly id: ProjectId;
  readonly workspaceRoot: string;
  readonly trackedFolders: ReadonlyArray<ProjectTrackedFolder>;
}

export type TaskFolderRepositoryStatus = "running" | "done" | "failed";

export interface TaskFolderProgress {
  readonly onFetch?: (status: "running" | "skipped" | "done") => Effect.Effect<void>;
  readonly onCheckoutStarted?: Effect.Effect<void>;
  /** The home worktree exists; removing it on cancel is safe from here on. */
  readonly onHomeClaimed?: (path: string) => Effect.Effect<void>;
  readonly onCheckoutProgress?: (percent: number) => Effect.Effect<void>;
  readonly onRepository?: (
    originalPath: string,
    status: TaskFolderRepositoryStatus,
    detail: string | null,
  ) => Effect.Effect<void>;
}

export interface TaskFolderCreateInput {
  readonly plan: TaskFolderPlan;
  /** The requested task branch; a clash in any repo picks a new name for all. */
  readonly branch: string;
  readonly baseRef: string;
  readonly startFromOrigin: boolean;
  /** Tracked paths to leave out ("Start without <repo>"). */
  readonly skipRepositoryPaths?: ReadonlyArray<string>;
}

export interface TaskFolderFailure {
  readonly name: string;
  readonly originalPath: string;
  readonly detail: string;
}

export interface TaskFolderCreated {
  readonly record: TaskFolderRecord;
  readonly failed: ReadonlyArray<TaskFolderFailure>;
}

export interface TaskFolderRemovedRepository {
  readonly name: string;
  readonly originalPath: string;
  readonly worktreePath: string;
  readonly outcome: "removed" | "kept";
  readonly detail: string | null;
}

export interface TaskFolderRemoval {
  readonly root: string;
  /** False when a repo was kept, which keeps the home worktree and the folder. */
  readonly removed: boolean;
  readonly repositories: ReadonlyArray<TaskFolderRemovedRepository>;
}

/**
 * Creates, repairs, renames, and removes task folders: one worktree per tracked Git repo of a
 * project, all on one task branch. The home worktree is created first and removed last, because
 * removing it deletes the worktrees nested inside it.
 */
export class TaskFolderService extends Context.Service<
  TaskFolderService,
  {
    /** Null for single-repo projects and non-Git homes; their worktrees stay single-repo. */
    readonly plan: (input: {
      readonly project: TaskFolderProject;
      readonly repositories?: ReadonlyArray<OrchestrationV2LaunchRepository> | undefined;
    }) => Effect.Effect<TaskFolderPlan | null, TaskFolderError>;
    /** One failed tracked repo keeps the others; it is listed in `failed`, never thrown. */
    readonly create: (
      input: TaskFolderCreateInput,
      progress?: TaskFolderProgress,
    ) => Effect.Effect<
      TaskFolderCreated & { readonly startedFromOrigin: boolean },
      TaskFolderError
    >;
    /** Retry: creates the planned repos the folder of `homeWorktreePath` lacks. */
    readonly complete: (
      input: {
        readonly plan: TaskFolderPlan;
        readonly homeWorktreePath: string;
        readonly startFromOrigin: boolean;
        readonly skipRepositoryPaths?: ReadonlyArray<string>;
      },
      progress?: TaskFolderProgress,
    ) => Effect.Effect<Option.Option<TaskFolderCreated>, TaskFolderError>;
    readonly find: (
      path: string,
    ) => Effect.Effect<Option.Option<TaskFolderRecord>, TaskFolderError>;
    /** Renames the task branch in every row still on it. None when `worktreePath` is no task folder. */
    readonly renameBranch: (input: {
      readonly worktreePath: string;
      readonly oldBranch: string;
      readonly newBranch: string;
      readonly exactName?: boolean;
    }) => Effect.Effect<Option.Option<{ readonly branch: string }>, TaskFolderError>;
    /** Recreates missing rows, home first. False when `worktreePath` is no task folder. */
    readonly repair: (worktreePath: string) => Effect.Effect<boolean, TaskFolderError>;
    /**
     * Removes a task folder by its home worktree (children first, never forcing a child), or one
     * child row by its own path. None when `path` is no task folder row.
     */
    readonly remove: (input: {
      readonly path: string;
      readonly force?: boolean | undefined;
    }) => Effect.Effect<Option.Option<TaskFolderRemoval>, TaskFolderError>;
    /** The current HEAD of each tracked repo a thread works in, for a delegate's own task folder. */
    readonly repositoryHeads: (input: {
      readonly project: TaskFolderProject;
      readonly worktreePath: string | null;
    }) => Effect.Effect<ReadonlyArray<OrchestrationV2LaunchRepository> | null, TaskFolderError>;
    /** Worktree mode in a multi-repo project: the PR's repo on the PR branch, the others on their default branch. */
    readonly preparePullRequestThread: (
      input: GitPreparePullRequestThreadInput,
    ) => Effect.Effect<GitPreparePullRequestThreadResult, GitManagerServiceError>;
  }
>()("t3/workspace/TaskFolderService") {}

const errorDetail = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "detail" in error) {
    const detail = (error as { readonly detail: unknown }).detail;
    if (typeof detail === "string" && detail.length > 0) return detail.split(/\r?\n/)[0]!;
  }
  if (error instanceof Error) return error.message.split(/\r?\n/)[0] ?? error.message;
  return String(error);
};

const failWith = (operation: string, detail: string, cause?: unknown) =>
  new TaskFolderError({ operation, detail, ...(cause === undefined ? {} : { cause }) });

const isTaskFolderError = Schema.is(TaskFolderError);

const mapFailure =
  (operation: string, detail?: (error: unknown) => string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError((cause) =>
        isTaskFolderError(cause)
          ? cause
          : failWith(operation, detail?.(cause) ?? errorDetail(cause), cause),
      ),
    );

interface RowStart {
  readonly refName: string;
  /** Omitted to check out `refName` as is (the PR branch). */
  readonly newRefName?: string;
  readonly baseRefName?: string;
  readonly baseRef: string;
}

interface Layout {
  readonly root: string | null;
  /** Null lets Git place home like a single-repo worktree; its path is then the root. */
  readonly homeWorktreePath: string | null;
  readonly rowPath: (homeWorktreePath: string, originalPath: string) => string;
}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const git = yield* GitWorkflow.GitWorkflowService;
  const gitDriver = yield* GitVcsDriver.GitVcsDriver;
  const store = yield* TaskFolderStore;
  const workspaces = yield* WorkspaceRepositories;
  const projects = yield* ProjectService.ProjectService;

  const within = (root: string, candidate: string) => {
    const relative = path.relative(root, candidate);
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  };
  const samePath = (left: string, right: string) => path.resolve(left) === path.resolve(right);
  const slashes = (relative: string) => relative.split(path.sep).join("/");
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  /** Deepest last; a nested repo needs its parent's worktree first. */
  const waves = <A>(items: ReadonlyArray<A>, pathOf: (item: A) => string) => {
    const depth = (item: A) =>
      items.filter((other) => other !== item && within(pathOf(other), pathOf(item))).length;
    const grouped = Map.groupBy(items, depth);
    return [...grouped.keys()].toSorted((a, b) => a - b).map((key) => grouped.get(key)!);
  };

  const refExists = (cwd: string, ref: string) =>
    gitDriver
      .execute({
        operation: "TaskFolderService.refExists",
        cwd,
        args: ["show-ref", "--verify", "--quiet", ref],
        allowNonZeroExit: true,
      })
      .pipe(Effect.map((result) => result.exitCode === 0));

  const anyRepoHasRef = (repos: ReadonlyArray<string>, ref: string) =>
    Effect.forEach(repos, (cwd) => refExists(cwd, ref), { concurrency: GIT_CONCURRENCY }).pipe(
      Effect.map((results) => results.some(Boolean)),
    );

  const worktreesDirectory = Effect.gen(function* () {
    const setting = yield* serverSettings.getSettings.pipe(
      Effect.map((settings) => settings.worktreesDirectory),
      Effect.orElseSucceed(() => ""),
    );
    const directory = resolveWorktreesDirectory(
      setting,
      config.worktreesDir,
      path,
      yield* HostProcess.HomeDirectory,
    );
    if (directory === null)
      return yield* failWith(
        "worktrees-directory",
        `The worktree location "${setting}" must be an absolute folder on this machine, not a drive root. Change it in Settings → Worktrees.`,
      );
    return directory;
  });

  // Leftover folders between worktrees, never files.
  const removeEmptyDirectories: (directory: string) => Effect.Effect<void> = Effect.fn(
    "TaskFolderService.removeEmptyDirectories",
  )(
    function* (directory: string): Effect.fn.Return<void, PlatformError | Cause.UnknownError> {
      const isLink = yield* fileSystem.readLink(directory).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (isLink || (yield* fileSystem.stat(directory)).type !== "Directory") return;
      for (const name of yield* fileSystem.readDirectory(directory)) {
        yield* removeEmptyDirectories(path.join(directory, name));
      }
      yield* removeEmptyDirectory(directory);
    },
    (effect) => Effect.ignore(effect),
  );

  const defaultBranch = Effect.fn("TaskFolderService.defaultBranch")(function* (cwd: string) {
    const remote = yield* gitDriver
      .resolvePrimaryRemoteName(cwd)
      .pipe(Effect.orElseSucceed(() => null));
    if (remote !== null) {
      const name = yield* gitDriver
        .resolveDefaultBranchName(cwd, remote)
        .pipe(Effect.orElseSucceed(() => null));
      if (name !== null) {
        if (yield* refExists(cwd, `refs/heads/${name}`)) return name;
        if (yield* refExists(cwd, `refs/remotes/${remote}/${name}`)) return `${remote}/${name}`;
      }
    }
    const head = yield* gitDriver.execute({
      operation: "TaskFolderService.currentBranch",
      cwd,
      args: ["symbolic-ref", "--quiet", "--short", "HEAD"],
      allowNonZeroExit: true,
    });
    return head.exitCode === 0 && head.stdout.trim() !== "" ? head.stdout.trim() : "HEAD";
  });

  // Same rule as a single-repo worktree: fetch the base only when it has a remote and the caller asks.
  const resolveStart = Effect.fn("TaskFolderService.resolveStart")(function* (
    cwd: string,
    baseRef: string | undefined,
    startFromOrigin: boolean,
    branch: string,
  ) {
    const base = baseRef ?? (yield* defaultBranch(cwd));
    if (
      startFromOrigin &&
      (yield* git.resolveWorktreeBaseRemote({ cwd, refName: base })) !== null
    ) {
      const remote = yield* git.fetchWorktreeBaseCommit({ cwd, refName: base });
      if (remote !== null)
        return {
          refName: remote.commitSha,
          newRefName: branch,
          baseRefName: `refs/remotes/${remote.remoteRefName}`,
          baseRef: base,
        } satisfies RowStart;
    }
    return {
      refName: base,
      newRefName: branch,
      baseRefName: base,
      baseRef: base,
    } satisfies RowStart;
  });

  const computeLayout = Effect.fn("TaskFolderService.computeLayout")(function* (
    plan: TaskFolderPlan,
    branch: string,
    /** A retry keeps the folder it recorded; the branch name may have changed since. */
    recordedRoot?: string,
  ) {
    const directory = yield* worktreesDirectory;
    const defaultRoot =
      recordedRoot ??
      path.join(directory, path.basename(path.resolve(plan.homePath)), branch.replace(/\//g, "-"));
    const childPath = (homeWorktreePath: string, originalPath: string) =>
      path.join(homeWorktreePath, path.relative(plan.homePath, originalPath));
    const siblings = plan.repositories.filter(
      (repository) => !within(plan.homePath, repository.originalPath),
    );
    if (siblings.length === 0)
      return {
        layout: { root: null, homeWorktreePath: null, rowPath: childPath } satisfies Layout,
        expectedRoot: defaultRoot,
      };
    let ancestor = path.resolve(plan.homePath);
    for (const sibling of siblings) {
      while (!within(ancestor, sibling.originalPath)) {
        // Repos on different Windows drives share no ancestor; dirname stops moving at the root.
        const parent = path.dirname(ancestor);
        if (parent === ancestor) break;
        ancestor = parent;
      }
    }
    const userHome = yield* HostProcess.HomeDirectory;
    if (!isFilesystemRoot(ancestor, path) && !within(ancestor, userHome)) {
      return {
        layout: {
          root: defaultRoot,
          homeWorktreePath: path.join(defaultRoot, path.relative(ancestor, plan.homePath)),
          rowPath: (homeWorktreePath, originalPath) =>
            within(plan.homePath, originalPath)
              ? childPath(homeWorktreePath, originalPath)
              : path.join(defaultRoot, path.relative(ancestor, originalPath)),
        } satisfies Layout,
        expectedRoot: defaultRoot,
      };
    }
    // Unrelated paths: one folder per repo by name, so `../` paths may not hold.
    const used = new Set<string>();
    const claim = (base: string) => {
      let name = base;
      for (let suffix = 2; used.has(name); suffix++) name = `${base}-${suffix}`;
      used.add(name);
      return name;
    };
    const homeFolder = claim(path.basename(plan.homePath));
    const siblingFolders = new Map(
      siblings.map((sibling) => [
        path.resolve(sibling.originalPath),
        claim(path.basename(sibling.originalPath)),
      ]),
    );
    return {
      layout: {
        root: defaultRoot,
        homeWorktreePath: path.join(defaultRoot, homeFolder),
        rowPath: (homeWorktreePath, originalPath) =>
          within(plan.homePath, originalPath)
            ? childPath(homeWorktreePath, originalPath)
            : path.join(defaultRoot, siblingFolders.get(path.resolve(originalPath))!),
      } satisfies Layout,
      expectedRoot: defaultRoot,
    };
  });

  /** A name no selected repo has and whose folder does not exist yet. */
  const resolveBranch = Effect.fn("TaskFolderService.resolveBranch")(function* (
    repos: ReadonlyArray<string>,
    requested: string,
    rootFor?: (branch: string) => Effect.Effect<string, TaskFolderError>,
  ) {
    let branch = requested;
    const temporary = isTemporaryWorktreeBranch(branch);
    // An existing `t3` branch blocks `t3/<hex>` refs.
    const flatten =
      temporary && (yield* anyRepoHasRef(repos, `refs/heads/${WORKTREE_BRANCH_PREFIX}`));
    if (flatten) branch = flattenTemporaryWorktreeBranchName(branch);
    for (let attempt = 0; attempt <= 100; attempt++) {
      let candidate = branch;
      if (attempt > 0 && temporary) {
        const uuid = yield* randomUuidV4;
        const fresh = buildTemporaryWorktreeBranchName(() => uuid.replaceAll("-", ""));
        candidate = flatten ? flattenTemporaryWorktreeBranchName(fresh) : fresh;
      } else if (attempt > 0) {
        candidate = `${branch}-${attempt}`;
      }
      if (
        rootFor !== undefined &&
        (yield* fileSystem
          .exists(yield* rootFor(candidate))
          .pipe(Effect.orElseSucceed(() => false)))
      )
        continue;
      if (!(yield* anyRepoHasRef(repos, `refs/heads/${candidate}`))) return candidate;
    }
    return yield* failWith(
      "resolve-branch",
      `Could not find a branch name like '${requested}' that is free in every repository.`,
    );
  });

  // Upserts serialize per call so incremental rows never overwrite each other.
  const makeRecorder = Effect.fn("TaskFolderService.makeRecorder")(function* (
    initial: TaskFolderRecord,
  ) {
    const rows = yield* Ref.make<ReadonlyArray<TaskFolderRepositoryRow>>(initial.repositories);
    const lock = yield* Semaphore.make(1);
    const save = lock.withPermits(1)(
      Effect.gen(function* () {
        const record: TaskFolderRecord = {
          ...initial,
          repositories: yield* Ref.get(rows),
          updatedAt: yield* nowIso,
        };
        yield* store.upsert(record);
        return record;
      }),
    );
    return {
      add: (row: TaskFolderRepositoryRow) =>
        Ref.update(rows, (current) => [...current, row]).pipe(Effect.andThen(save)),
      save,
    };
  });

  const createRows = Effect.fn("TaskFolderService.createRows")(function* (input: {
    readonly record: TaskFolderRecord;
    readonly repositories: ReadonlyArray<TaskFolderPlanRepository>;
    readonly rowPath: (originalPath: string) => string;
    readonly startFor: (
      repository: TaskFolderPlanRepository,
    ) => Effect.Effect<RowStart, GitCommandError>;
    readonly branchFor: (start: RowStart) => string;
    readonly progress: TaskFolderProgress | undefined;
  }) {
    const recorder = yield* makeRecorder(input.record);
    const failed: Array<TaskFolderFailure> = [];
    const report = (
      repository: TaskFolderPlanRepository,
      status: TaskFolderRepositoryStatus,
      detail: string | null,
    ) => input.progress?.onRepository?.(repository.originalPath, status, detail) ?? Effect.void;
    const failedPaths = new Set<string>();
    for (const wave of waves(input.repositories, (repository) =>
      input.rowPath(repository.originalPath),
    )) {
      yield* Effect.forEach(
        wave,
        (repository) =>
          Effect.gen(function* () {
            const worktreePath = input.rowPath(repository.originalPath);
            const blockedBy = [...failedPaths].find((failedPath) =>
              within(failedPath, worktreePath),
            );
            if (blockedBy !== undefined) {
              return yield* failWith("create-repository", "its parent repository failed");
            }
            yield* report(repository, "running", null);
            const start = yield* input.startFor(repository);
            const created = yield* git.createWorktree({
              cwd: repository.originalPath,
              refName: start.refName,
              ...(start.newRefName === undefined ? {} : { newRefName: start.newRefName }),
              ...(start.baseRefName === undefined ? {} : { baseRefName: start.baseRefName }),
              path: worktreePath,
            });
            yield* recorder.add({
              kind: "repository",
              name: repository.name,
              originalPath: repository.originalPath,
              worktreePath: created.worktree.path,
              relativePath: slashes(
                path.relative(input.record.homeWorktreePath, created.worktree.path),
              ),
              baseRef: start.baseRef,
              branch: input.branchFor(start),
            });
            yield* report(repository, "done", null);
          }).pipe(
            Effect.catch((cause) => {
              const detail = errorDetail(cause);
              failed.push({ name: repository.name, originalPath: repository.originalPath, detail });
              failedPaths.add(input.rowPath(repository.originalPath));
              return report(repository, "failed", detail);
            }),
          ),
        { concurrency: GIT_CONCURRENCY, discard: true },
      );
    }
    return { record: yield* recorder.save, failed } satisfies TaskFolderCreated;
  });

  const plan: TaskFolderService["Service"]["plan"] = Effect.fn("TaskFolderService.plan")(
    function* (input) {
      if (input.project.trackedFolders.length === 0) return null;
      const workspace = yield* workspaces
        .resolveThreadWorkspace({ projectId: input.project.id, worktreePath: null })
        .pipe(mapFailure("plan"));
      const home = workspace.repositories.find((repository) => repository.kind === "home");
      const tracked = workspace.repositories.filter(
        (repository) =>
          repository.kind === "repository" &&
          // A repo that holds the home folder cannot be laid out around it.
          !within(repository.originalPath, home?.originalPath ?? repository.originalPath),
      );
      if (home === undefined || tracked.length === 0) return null;
      const selected =
        input.repositories === undefined
          ? tracked.map((repository) => ({ repository, baseRef: undefined }))
          : input.repositories.flatMap((selection) => {
              const repository = tracked.find((candidate) =>
                samePath(candidate.originalPath, selection.path),
              );
              return repository === undefined ? [] : [{ repository, baseRef: selection.baseRef }];
            });
      return {
        projectId: input.project.id,
        homeName: home.name,
        homePath: path.resolve(home.originalPath),
        repositories: selected.map(({ repository, baseRef }) => ({
          name: repository.name,
          originalPath: path.resolve(repository.originalPath),
          baseRef,
        })),
      };
    },
  );

  const create: TaskFolderService["Service"]["create"] = Effect.fn("TaskFolderService.create")(
    function* (input, progress) {
      const { plan: folderPlan } = input;
      const skip = input.skipRepositoryPaths ?? [];
      const selected = folderPlan.repositories.filter(
        (repository) => !skip.some((skipped) => samePath(skipped, repository.originalPath)),
      );
      const branch = yield* resolveBranch(
        [folderPlan.homePath, ...selected.map((repository) => repository.originalPath)],
        input.branch,
        (candidate) =>
          computeLayout(folderPlan, candidate).pipe(Effect.map(({ expectedRoot }) => expectedRoot)),
      ).pipe(mapFailure("resolve-branch"));
      // Lay out every planned repo so a retry without a skipped one keeps the same paths.
      const { layout } = yield* computeLayout(folderPlan, branch);

      const shouldFetch =
        input.startFromOrigin &&
        (yield* git
          .resolveWorktreeBaseRemote({ cwd: folderPlan.homePath, refName: input.baseRef })
          .pipe(mapFailure("resolve-base"))) !== null;
      yield* progress?.onFetch?.(shouldFetch ? "running" : "skipped") ?? Effect.void;
      const homeStart = yield* resolveStart(
        folderPlan.homePath,
        input.baseRef,
        shouldFetch,
        branch,
      ).pipe(mapFailure("fetch-base"));
      if (shouldFetch) yield* progress?.onFetch?.("done") ?? Effect.void;
      yield* progress?.onCheckoutStarted ?? Effect.void;

      const home = yield* git
        .createWorktree(
          {
            cwd: folderPlan.homePath,
            refName: homeStart.refName,
            newRefName: branch,
            baseRefName: homeStart.baseRefName,
            path: layout.homeWorktreePath,
          },
          {
            progress: {
              ...(progress?.onHomeClaimed === undefined
                ? {}
                : { onWorktreeClaimed: progress.onHomeClaimed }),
              ...(progress?.onCheckoutProgress === undefined
                ? {}
                : {
                    onCheckoutProgress: (checkout: { readonly percent: number }) =>
                      progress.onCheckoutProgress!(checkout.percent),
                  }),
            },
          },
        )
        .pipe(
          mapFailure("create-home"),
          Effect.tapError(() =>
            layout.root === null ? Effect.void : removeEmptyDirectories(layout.root),
          ),
        );
      const homeWorktreePath = home.worktree.path;
      const now = yield* nowIso;
      const record: TaskFolderRecord = {
        root: layout.root ?? homeWorktreePath,
        projectId: folderPlan.projectId,
        homeWorktreePath,
        repositories: [
          {
            kind: "home",
            name: folderPlan.homeName,
            originalPath: folderPlan.homePath,
            worktreePath: homeWorktreePath,
            relativePath: "",
            baseRef: homeStart.baseRef,
            branch: home.worktree.refName,
          },
        ],
        createdAt: now,
        updatedAt: now,
      };
      yield* store.upsert(record).pipe(mapFailure("record"));
      const created = yield* createRows({
        record,
        repositories: selected,
        rowPath: (originalPath) => layout.rowPath(homeWorktreePath, originalPath),
        startFor: (repository) =>
          resolveStart(repository.originalPath, repository.baseRef, input.startFromOrigin, branch),
        branchFor: () => branch,
        progress,
      }).pipe(mapFailure("create-repositories"));
      return {
        ...created,
        startedFromOrigin: homeStart.baseRefName?.startsWith("refs/remotes/") === true,
      };
    },
  );

  const find: TaskFolderService["Service"]["find"] = (candidate) =>
    store.findContaining(path.resolve(candidate)).pipe(mapFailure("find"));

  const complete: TaskFolderService["Service"]["complete"] = Effect.fn(
    "TaskFolderService.complete",
  )(function* (input, progress) {
    const existing = yield* find(input.homeWorktreePath);
    if (
      Option.isNone(existing) ||
      !samePath(existing.value.homeWorktreePath, input.homeWorktreePath)
    )
      return Option.none();
    const record = existing.value;
    const home = record.repositories.find((row) => row.kind === "home");
    const branch = home?.branch ?? null;
    if (home === undefined || branch === null) return Option.none();
    const skip = input.skipRepositoryPaths ?? [];
    for (const row of record.repositories) {
      if (row.kind === "repository")
        yield* progress?.onRepository?.(row.originalPath, "done", null) ?? Effect.void;
    }
    const missing = input.plan.repositories.filter(
      (repository) =>
        !skip.some((skipped) => samePath(skipped, repository.originalPath)) &&
        !record.repositories.some((row) => samePath(row.originalPath, repository.originalPath)),
    );
    const { layout } = yield* computeLayout(input.plan, branch, record.root);
    return Option.some(
      yield* createRows({
        record,
        repositories: missing,
        rowPath: (originalPath) => layout.rowPath(record.homeWorktreePath, originalPath),
        startFor: (repository) =>
          resolveStart(repository.originalPath, repository.baseRef, input.startFromOrigin, branch),
        branchFor: () => branch,
        progress,
      }).pipe(mapFailure("create-repositories")),
    );
  });

  const renameBranch: TaskFolderService["Service"]["renameBranch"] = Effect.fn(
    "TaskFolderService.renameBranch",
  )(function* (input) {
    const existing = yield* find(input.worktreePath);
    if (Option.isNone(existing) || !samePath(existing.value.homeWorktreePath, input.worktreePath))
      return Option.none();
    const rows = existing.value.repositories.filter((row) => row.branch === input.oldBranch);
    const home = rows.find((row) => row.kind === "home");
    if (home === undefined)
      return yield* failWith("rename-branch", "The home worktree is no longer on the task branch.");
    let target = input.newBranch;
    if (input.exactName !== true) {
      const candidates = [
        input.newBranch,
        ...Array.from({ length: 100 }, (_, index) => `${input.newBranch}-${index + 1}`),
      ];
      const free = yield* Effect.findFirst(candidates, (candidate) =>
        anyRepoHasRef(
          rows.map((row) => row.originalPath),
          `refs/heads/${candidate}`,
        ).pipe(Effect.map((taken) => !taken)),
      ).pipe(mapFailure("rename-branch"));
      if (Option.isNone(free))
        return yield* failWith(
          "rename-branch",
          `Could not find a branch name like '${input.newBranch}' that is free in every repository.`,
        );
      target = free.value;
    }
    yield* git
      .renameBranch({
        cwd: home.worktreePath,
        oldBranch: input.oldBranch,
        newBranch: target,
        exactName: true,
      })
      .pipe(mapFailure("rename-branch"));
    const renamed = new Set([home.worktreePath]);
    yield* Effect.forEach(
      rows.filter((row) => row.kind === "repository"),
      (row) =>
        git
          .renameBranch({
            cwd: row.worktreePath,
            oldBranch: input.oldBranch,
            newBranch: target,
            exactName: true,
          })
          .pipe(
            Effect.tap(() => Effect.sync(() => renamed.add(row.worktreePath))),
            Effect.catchCause((cause) =>
              Effect.logWarning("Task folder branch rename skipped a repository", {
                worktreePath: row.worktreePath,
                cause,
              }),
            ),
          ),
      { concurrency: GIT_CONCURRENCY, discard: true },
    );
    // Reread so a concurrent row update is not lost.
    const latest = yield* store.get(existing.value.root).pipe(mapFailure("rename-branch"));
    if (Option.isSome(latest)) {
      yield* store
        .upsert({
          ...latest.value,
          repositories: latest.value.repositories.map((row) =>
            renamed.has(row.worktreePath) && row.branch === input.oldBranch
              ? { ...row, branch: target }
              : row,
          ),
          updatedAt: yield* nowIso,
        })
        .pipe(mapFailure("rename-branch"));
    }
    return Option.some({ branch: target });
  });

  const recreateRow = Effect.fn("TaskFolderService.recreateRow")(function* (
    row: TaskFolderRepositoryRow,
  ) {
    yield* git.pruneWorktrees({ cwd: row.originalPath });
    if (row.branch === null) {
      return yield* failWith("repair", `${row.name} has no branch to recreate.`);
    }
    if (yield* refExists(row.originalPath, `refs/heads/${row.branch}`)) {
      yield* git.createWorktree({
        cwd: row.originalPath,
        refName: row.branch,
        path: row.worktreePath,
      });
      return;
    }
    yield* git.createWorktree({
      cwd: row.originalPath,
      refName: row.baseRef,
      newRefName: row.branch,
      baseRefName: row.baseRef,
      path: row.worktreePath,
    });
  });

  const repair: TaskFolderService["Service"]["repair"] = Effect.fn("TaskFolderService.repair")(
    function* (worktreePath) {
      const existing = yield* find(worktreePath);
      if (Option.isNone(existing)) return false;
      const missing = yield* Effect.filter(existing.value.repositories, (row) =>
        fileSystem.exists(row.worktreePath).pipe(Effect.map((exists) => !exists)),
      ).pipe(mapFailure("repair"));
      const home = missing.find((row) => row.kind === "home");
      if (home !== undefined) yield* recreateRow(home).pipe(mapFailure("repair"));
      const children = missing.filter((row) => row.kind === "repository");
      for (const wave of waves(children, (row) => row.worktreePath)) {
        yield* Effect.forEach(
          wave,
          (row) =>
            recreateRow(row).pipe(
              // A missing child must not block the thread; the agent works without it.
              Effect.catchCause((cause) =>
                Effect.logWarning("Could not recreate a task folder repository", {
                  worktreePath: row.worktreePath,
                  cause,
                }),
              ),
            ),
          { concurrency: GIT_CONCURRENCY, discard: true },
        );
      }
      return true;
    },
  );

  const removeRow = (row: TaskFolderRepositoryRow, force: boolean) =>
    git.removeWorktree({ cwd: row.originalPath, path: row.worktreePath, force }).pipe(
      Effect.as<TaskFolderRemovedRepository>({
        name: row.name,
        originalPath: row.originalPath,
        worktreePath: row.worktreePath,
        outcome: "removed",
        detail: null,
      }),
      Effect.catch((cause) =>
        Effect.succeed<TaskFolderRemovedRepository>({
          name: row.name,
          originalPath: row.originalPath,
          worktreePath: row.worktreePath,
          outcome: "kept",
          detail: errorDetail(cause),
        }),
      ),
    );

  const remove: TaskFolderService["Service"]["remove"] = Effect.fn("TaskFolderService.remove")(
    function* (input) {
      const existing = yield* find(input.path);
      if (Option.isNone(existing)) return Option.none();
      const record = existing.value;
      const target = record.repositories.find((row) => samePath(row.worktreePath, input.path));
      if (target === undefined) return Option.none();
      const forget = Effect.fn("TaskFolderService.forget")(function* (
        removed: ReadonlyArray<TaskFolderRemovedRepository>,
      ) {
        const gone = new Set(
          removed.filter((entry) => entry.outcome === "removed").map((entry) => entry.worktreePath),
        );
        const latest = yield* store.get(record.root).pipe(mapFailure("remove"));
        if (Option.isNone(latest)) return;
        yield* store
          .upsert({
            ...latest.value,
            repositories: latest.value.repositories.filter((row) => !gone.has(row.worktreePath)),
            updatedAt: yield* nowIso,
          })
          .pipe(mapFailure("remove"));
      });

      // Deepest first. Removing a worktree deletes the repos nested in it, so a repo that holds
      // one that was kept stays too.
      const removeDeepestFirst = Effect.fn("TaskFolderService.removeDeepestFirst")(function* (
        rows: ReadonlyArray<TaskFolderRepositoryRow>,
      ) {
        const removed: Array<TaskFolderRemovedRepository> = [];
        for (const wave of waves(rows, (row) => row.worktreePath).toReversed()) {
          const keptPaths = removed
            .filter((entry) => entry.outcome === "kept")
            .map((entry) => entry.worktreePath);
          removed.push(
            ...(yield* Effect.forEach(
              wave,
              (row) =>
                keptPaths.some((keptPath) => within(row.worktreePath, keptPath))
                  ? Effect.succeed<TaskFolderRemovedRepository>({
                      name: row.name,
                      originalPath: row.originalPath,
                      worktreePath: row.worktreePath,
                      outcome: "kept",
                      detail: "It holds a repo that was kept.",
                    })
                  : removeRow(row, false),
              { concurrency: GIT_CONCURRENCY },
            )),
          );
        }
        return removed;
      });

      if (target.kind === "repository") {
        const subtree = record.repositories.filter(
          (row) => row.kind === "repository" && within(target.worktreePath, row.worktreePath),
        );
        const removed = yield* removeDeepestFirst(subtree);
        yield* forget(removed);
        return Option.some({ root: record.root, removed: false, repositories: removed });
      }

      const results = yield* removeDeepestFirst(
        record.repositories.filter((row) => row.kind === "repository"),
      );
      if (results.some((entry) => entry.outcome === "kept")) {
        yield* forget(results);
        return Option.some({ root: record.root, removed: false, repositories: results });
      }
      const homeResult = yield* removeRow(target, input.force === true);
      results.push(homeResult);
      if (homeResult.outcome === "kept") {
        yield* forget(results);
        return Option.some({ root: record.root, removed: false, repositories: results });
      }
      if (record.root !== record.homeWorktreePath) yield* removeEmptyDirectories(record.root);
      yield* store.remove(record.root).pipe(mapFailure("remove"));
      return Option.some({ root: record.root, removed: true, repositories: results });
    },
  );

  const repositoryHeads: TaskFolderService["Service"]["repositoryHeads"] = Effect.fn(
    "TaskFolderService.repositoryHeads",
  )(function* (input) {
    if (input.project.trackedFolders.length === 0) return null;
    const workspace = yield* workspaces
      .resolveThreadWorkspace({ projectId: input.project.id, worktreePath: input.worktreePath })
      .pipe(mapFailure("repository-heads"));
    const tracked = workspace.repositories.filter((repository) => repository.kind === "repository");
    if (tracked.length === 0) return null;
    return yield* Effect.forEach(
      tracked,
      (repository) =>
        gitDriver.resolveCommit({ cwd: repository.cwd, revision: "HEAD" }).pipe(
          Effect.map((head) => ({ path: repository.originalPath, baseRef: head.commitSha })),
          mapFailure("repository-heads", () => `Unable to resolve the HEAD of ${repository.name}.`),
        ),
      { concurrency: GIT_CONCURRENCY },
    );
  });

  const projectForPath = Effect.fn("TaskFolderService.projectForPath")(function* (cwd: string) {
    const byRoot = yield* projects.getByWorkspaceRoot(cwd);
    if (Option.isSome(byRoot)) return Option.some(byRoot.value);
    const shells = yield* projects.listShells();
    const shell = shells.find((candidate) =>
      candidate.trackedFolders.some((folder) => samePath(folder.path, cwd)),
    );
    return shell === undefined ? Option.none() : yield* projects.getById(shell.id);
  });

  const preparePullRequestThread: TaskFolderService["Service"]["preparePullRequestThread"] =
    Effect.fn("TaskFolderService.preparePullRequestThread")(function* (input) {
      if (input.mode !== "worktree") return yield* git.preparePullRequestThread(input);
      const fail = (detail: string, cause?: unknown) =>
        new GitManagerError({
          operation: "TaskFolderService.preparePullRequestThread",
          cwd: input.cwd,
          detail,
          ...(cause === undefined ? {} : { cause }),
        });
      const toGitError = Effect.mapError((cause: unknown) => fail(errorDetail(cause), cause));
      // A failed lookup keeps today's single-repo checkout.
      const project = yield* projectForPath(path.resolve(input.cwd)).pipe(
        Effect.orElseSucceed(() => Option.none()),
      );
      const folderPlan = Option.isNone(project)
        ? null
        : yield* plan({ project: project.value }).pipe(toGitError);
      if (folderPlan === null) return yield* git.preparePullRequestThread(input);
      const pullRequestPath = path.resolve(input.cwd);
      const pullRequestRepository = folderPlan.repositories.find((repository) =>
        samePath(repository.originalPath, pullRequestPath),
      );
      if (!samePath(folderPlan.homePath, pullRequestPath) && pullRequestRepository === undefined)
        return yield* git.preparePullRequestThread(input);

      const holder: { created: TaskFolderCreated | null } = { created: null };
      const checkout = Effect.fn("TaskFolderService.checkoutPullRequest")(function* (
        pullRequestBranch: string,
      ) {
        const others = [
          folderPlan.homePath,
          ...folderPlan.repositories.map((r) => r.originalPath),
        ].filter((cwd) => !samePath(cwd, pullRequestPath));
        // The others share one new branch named after the PR branch.
        const branch = yield* resolveBranch(others, pullRequestBranch);
        const { layout } = yield* computeLayout(folderPlan, pullRequestBranch);
        const homeStart: RowStart = samePath(folderPlan.homePath, pullRequestPath)
          ? { refName: pullRequestBranch, baseRef: pullRequestBranch }
          : yield* resolveStart(folderPlan.homePath, undefined, false, branch);
        const home = yield* git.createWorktree({
          cwd: folderPlan.homePath,
          refName: homeStart.refName,
          ...(homeStart.newRefName === undefined ? {} : { newRefName: homeStart.newRefName }),
          ...(homeStart.baseRefName === undefined ? {} : { baseRefName: homeStart.baseRefName }),
          path: layout.homeWorktreePath,
        });
        const now = yield* nowIso;
        const record: TaskFolderRecord = {
          root: layout.root ?? home.worktree.path,
          projectId: folderPlan.projectId,
          homeWorktreePath: home.worktree.path,
          repositories: [
            {
              kind: "home",
              name: folderPlan.homeName,
              originalPath: folderPlan.homePath,
              worktreePath: home.worktree.path,
              relativePath: "",
              baseRef: homeStart.baseRef,
              branch: home.worktree.refName,
            },
          ],
          createdAt: now,
          updatedAt: now,
        };
        const folder = yield* Effect.gen(function* () {
          yield* store.upsert(record);
          const created = yield* createRows({
            record,
            repositories: folderPlan.repositories,
            rowPath: (originalPath) => layout.rowPath(home.worktree.path, originalPath),
            startFor: (repository) =>
              samePath(repository.originalPath, pullRequestPath)
                ? Effect.succeed({ refName: pullRequestBranch, baseRef: pullRequestBranch })
                : resolveStart(repository.originalPath, undefined, false, branch),
            branchFor: (start) => start.newRefName ?? start.refName,
            progress: undefined,
          });
          const failure = created.failed.find((entry) =>
            samePath(entry.originalPath, pullRequestPath),
          );
          if (failure !== undefined) return yield* fail(failure.detail);
          return created;
        }).pipe(
          Effect.onError(() =>
            remove({ path: home.worktree.path, force: true }).pipe(Effect.ignore),
          ),
        );
        holder.created = folder;
        const pullRequestRow = folder.record.repositories.find((row) =>
          samePath(row.originalPath, pullRequestPath),
        );
        if (pullRequestRow === undefined) {
          return yield* fail("The pull request checkout failed.");
        }
        return {
          worktreePath: home.worktree.path,
          branch: home.worktree.refName,
          pullRequestWorktreePath: pullRequestRow.worktreePath,
          projectCwd: folderPlan.homePath,
        };
      }, toGitError);
      const result = yield* git.preparePullRequestThread(input, { checkout });
      const folder = holder.created;
      if (folder !== null) {
        if (folder.failed.length > 0)
          yield* Effect.logWarning("Pull request task folder left out repositories", {
            failed: folder.failed,
          });
        return result;
      }
      // Git reused a worktree that already had the PR branch.
      if (result.worktreePath === null) return result;
      const reused = yield* find(result.worktreePath).pipe(toGitError);
      if (Option.isSome(reused)) {
        const home = reused.value.repositories.find((row) => row.kind === "home");
        return {
          ...result,
          worktreePath: reused.value.homeWorktreePath,
          branch: home?.branch ?? result.branch,
        };
      }
      if (samePath(folderPlan.homePath, pullRequestPath)) return result;
      return yield* fail(
        `The pull request branch is already checked out at ${result.worktreePath}. Remove that worktree, or use Local.`,
      );
    });

  return TaskFolderService.of({
    plan,
    create,
    complete,
    find,
    renameBranch,
    repair,
    remove,
    repositoryHeads,
    preparePullRequestThread,
  });
});

export const layer = Layer.effect(TaskFolderService, make);
