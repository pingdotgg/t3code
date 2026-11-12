import {
  CommandId,
  type GitCommandError,
  type OrchestrationV2AppThread,
  type ProjectId,
  type ThreadId,
  type ThreadRepoWorktree,
  type VcsRemoveWorktreeInput,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as CheckpointService from "../orchestration-v2/CheckpointService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { withRepositoryLease } from "../workspace/workspaceLease.ts";
import { resolveWorktreesDirectory } from "../worktreesDirectory.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";

export class RepoWorktreesDisabledError extends Schema.TaggedError<RepoWorktreesDisabledError>()(
  "RepoWorktreesDisabledError",
  { projectId: Schema.String },
) {
  override get message(): string {
    return "Multi-Repository Project Folder is off for this project. Turn it on in the project's Worktrees settings first.";
  }
}

export class RepoWorktreeThreadUnavailableError extends Schema.TaggedError<RepoWorktreeThreadUnavailableError>()(
  "RepoWorktreeThreadUnavailableError",
  {
    threadId: Schema.String,
    state: Schema.Literals(["missing", "archived"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.state === "archived"
      ? `Thread ${this.threadId} is archived.`
      : `Thread ${this.threadId} was not found.`;
  }
}

/** A request the repository's current state refuses; nothing was changed. */
export class RepoWorktreeRequestError extends Schema.TaggedError<RepoWorktreeRequestError>()(
  "RepoWorktreeRequestError",
  {
    reason: Schema.Literals([
      "outside_project",
      "not_a_repository",
      "invalid_branch",
      "base_ref_required",
      "base_missing",
      "branch_exists",
      "branch_missing",
      "branch_in_source_checkout",
      "branch_mismatch",
      "location_invalid",
      "path_unavailable",
      "not_attached",
      "not_a_submodule",
      "submodule_changes",
      "source_mismatch",
    ]),
    path: Schema.optional(Schema.String),
    branch: Schema.optional(Schema.String),
    baseRef: Schema.optional(Schema.String),
    /** What Git checked out instead of the branch; absent for a detached HEAD. */
    actualBranch: Schema.optional(Schema.String),
    remote: Schema.optional(Schema.Boolean),
  },
) {
  override get message(): string {
    const path = this.path ?? "the path";
    const branch = this.branch ?? "the branch";
    switch (this.reason) {
      case "base_missing":
        return this.remote === true
          ? `Base '${this.baseRef}' is not a local branch or commit in ${path}; only origin has it.`
          : `Base '${this.baseRef}' is not a branch, tag, or commit in ${path}.`;
      case "branch_mismatch":
        return `Git checked out ${this.actualBranch === undefined ? "a detached HEAD" : `'${this.actualBranch}'`} instead of '${branch}' at ${path}. That new worktree was removed and nothing was attached.`;
      case "outside_project":
        return `${path} is not a Git repository inside the project folder.`;
      case "not_a_repository":
        return `${path} is not a Git repository.`;
      case "invalid_branch":
        return `'${branch}' is not a valid branch name.`;
      case "base_ref_required":
        return `Branch '${branch}' does not exist in ${path} yet. Give the branch or ref it should start from.`;
      case "branch_exists":
        return `Branch '${branch}' already exists ${this.remote === true ? "on origin" : "locally"} in ${path} and has no worktree. Continue it explicitly, or choose a new branch name for new work.`;
      case "branch_missing":
        return `Branch '${branch}' does not exist in ${path}, locally or on origin.`;
      case "branch_in_source_checkout":
        return `Branch '${branch}' is checked out in the source checkout at ${path}. Choose another branch so the source checkout stays untouched.`;
      case "location_invalid":
        return "The worktree location must be an absolute folder on this machine, not a drive root. Change it in Settings, Storage.";
      case "path_unavailable":
        return `No free folder is left for a new worktree near ${path}.`;
      case "not_attached":
        return `${path} is not a repository worktree attached to this thread.`;
      case "not_a_submodule":
        return `${path} is not a submodule of that worktree.`;
      case "submodule_changes":
        return `The submodule at ${path} has uncommitted changes. Commit or move them first; they were left as they are.`;
      case "source_mismatch":
        return `The source worktree is not a checkout of the repository used by the submodule at ${path}.`;
    }
  }
}

export class RepoWorktreeDispatchError extends Schema.TaggedError<RepoWorktreeDispatchError>()(
  "RepoWorktreeDispatchError",
  {
    threadId: Schema.String,
    operation: Schema.Literals(["attach", "detach"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not ${this.operation} the repository worktree for thread ${this.threadId}.`;
  }
}

export class RepoWorktreeReadError extends Schema.TaggedError<RepoWorktreeReadError>()(
  "RepoWorktreeReadError",
  {
    operation: Schema.Literals(["settings", "project", "attachments"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not read the ${
      this.operation === "settings"
        ? "server settings"
        : this.operation === "project"
          ? "project"
          : "threads' repository worktrees"
    }.`;
  }
}

/** A removal refused because a thread still works in the checkout; nothing was changed. */
export class RepoWorktreeInUseError extends Schema.TaggedError<RepoWorktreeInUseError>()(
  "RepoWorktreeInUseError",
  {
    path: Schema.String,
    threadId: Schema.String,
    threadTitle: Schema.String,
  },
) {
  override get message(): string {
    return `Thread "${this.threadTitle}" works in ${this.path} as a repository worktree, so it was kept. Detach it from that thread to delete it.`;
  }
}

export interface RepoWorktreeEnsureInput {
  readonly threadId: ThreadId;
  readonly repository: string;
  readonly branch: string;
  readonly baseRef?: string | undefined;
  readonly startFromOrigin?: boolean | undefined;
  readonly useExistingBranch?: boolean | undefined;
}

export interface RepoWorktreeEnsureResult {
  readonly status: "created" | "reused";
  readonly branchCreated: boolean;
  readonly alreadyAttached: boolean;
  readonly uncommittedFiles: number;
  readonly startedFromOrigin: boolean;
  readonly repoWorktree: ThreadRepoWorktree;
}

export interface RepoWorktreeSetSubmoduleInput {
  readonly threadId: ThreadId;
  readonly worktreePath: string;
  readonly submodulePath: string;
  readonly sourceWorktreePath: string;
  readonly commit?: string | undefined;
  readonly stage?: boolean | undefined;
}

export interface RepoWorktreeSetSubmoduleResult {
  readonly worktreePath: string;
  readonly submodulePath: string;
  readonly commit: string;
  readonly previousCommit: string | null;
  readonly fetched: boolean;
  readonly staged: boolean;
}

export type RepoWorktreeFailure =
  | RepoWorktreesDisabledError
  | RepoWorktreeThreadUnavailableError
  | RepoWorktreeRequestError
  | RepoWorktreeDispatchError
  | RepoWorktreeReadError
  | GitCommandError;

export class RepoWorktreeService extends Context.Service<
  RepoWorktreeService,
  {
    /** Attaches a worktree of a repository in the project folder, creating it only when needed. */
    readonly ensure: (
      input: RepoWorktreeEnsureInput,
    ) => Effect.Effect<RepoWorktreeEnsureResult, RepoWorktreeFailure>;
    /**
     * Relabels every thread that has the checkout at `cwd` attached with its
     * current branch, after something switched it, so the branch shown and the
     * one a rollback recreates a removed folder from stay current.
     */
    readonly recordBranch: (input: {
      readonly cwd: string;
    }) => Effect.Effect<void, RepoWorktreeFailure>;
    /** Forgets an attached worktree. Works with the setting off; never touches files. */
    readonly detach: (input: {
      readonly threadId: ThreadId;
      readonly worktreePath: string;
    }) => Effect.Effect<
      { readonly detached: boolean; readonly worktreePath: string },
      RepoWorktreeFailure
    >;
    /** Points a parent worktree's submodule at a commit from another attached worktree. */
    readonly setSubmoduleCommit: (
      input: RepoWorktreeSetSubmoduleInput,
    ) => Effect.Effect<RepoWorktreeSetSubmoduleResult, RepoWorktreeFailure>;
    /**
     * Removes a worktree unless a thread has it attached as a repository
     * worktree. Forced removals are refused the same way, so user deletes and
     * the undo of a canceled or failed setup or handoff all go through here.
     */
    readonly removeWorktree: (
      input: VcsRemoveWorktreeInput,
    ) => Effect.Effect<void, RepoWorktreeInUseError | RepoWorktreeReadError | GitCommandError>;
  }
>()("t3/git/RepoWorktreeService") {}

interface WorktreeEntry {
  readonly path: string;
  readonly branchRef: string | null;
  readonly prunable: boolean;
}

/** `git worktree list --porcelain` records; the first is always the main worktree. */
function parseWorktreeList(stdout: string): ReadonlyArray<WorktreeEntry> {
  return stdout.split("\0\0").flatMap((record) => {
    const fields = record.split("\0").filter((field) => field.length > 0);
    const worktree = fields.find((field) => field.startsWith("worktree "));
    if (worktree === undefined) return [];
    const branch = fields.find((field) => field.startsWith("branch "));
    return [
      {
        path: worktree.slice("worktree ".length),
        branchRef: branch === undefined ? null : branch.slice("branch ".length),
        prunable: fields.some((field) => field === "prunable" || field.startsWith("prunable ")),
      },
    ];
  });
}

const SETTLED_RUN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const projects = yield* ProjectService.ProjectService;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const checkpoints = yield* CheckpointService.CheckpointServiceV2;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const isWindows = yield* HostProcess.isWindows;
  const repositoryLocks = yield* KeyedLock.make<string>();

  const pathKey = (target: string) => {
    const resolved = path.resolve(target);
    return isWindows ? resolved.toLowerCase() : resolved;
  };
  const insideOrEqual = (root: string, target: string) => {
    const relative = path.relative(pathKey(root), pathKey(target));
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  };
  const realPathOr = (target: string) =>
    fileSystem.realPath(target).pipe(Effect.orElseSucceed(() => path.resolve(target)));
  const sameWorktree = (left: string, right: string) => pathKey(left) === pathKey(right);
  // Git reports a checkout by its real path while settings may reach it
  // through a link (/tmp and /private/tmp), so attachments compare this.
  const pathIdentity = (target: string) => realPathOr(target).pipe(Effect.map(pathKey));

  const run = (cwd: string, operation: string, args: ReadonlyArray<string>) =>
    git.execute({ operation: `RepoWorktreeService.${operation}`, cwd, args, timeoutMs: 60_000 });
  const probe = (cwd: string, operation: string, args: ReadonlyArray<string>) =>
    git
      .execute({
        operation: `RepoWorktreeService.${operation}`,
        cwd,
        args,
        allowNonZeroExit: true,
        timeoutMs: 30_000,
      })
      .pipe(Effect.map((result) => ({ ok: result.exitCode === 0, stdout: result.stdout.trim() })));

  const loadThread = (threadId: ThreadId) =>
    threadManagement.getThreadRecords(threadId, []).pipe(
      Effect.map((projection) => projection.thread),
      Effect.mapError(
        (cause) => new RepoWorktreeThreadUnavailableError({ threadId, state: "missing", cause }),
      ),
      Effect.filterOrFail(
        (thread) => thread.deletedAt === null,
        () => new RepoWorktreeThreadUnavailableError({ threadId, state: "missing" }),
      ),
    );

  const loadProject = (projectId: ProjectId) =>
    projects.getById(projectId).pipe(
      Effect.mapError((cause) => new RepoWorktreeReadError({ operation: "project", cause })),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new RepoWorktreeReadError({ operation: "project", cause: "Project not found." }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

  const loadSettings = (projectId: ProjectId) =>
    settingsService.getSettings.pipe(
      Effect.map((settings) => resolveProjectSettings(settings, projectId).settings),
      Effect.mapError((cause) => new RepoWorktreeReadError({ operation: "settings", cause })),
    );

  /** The thread, its project, and resolved settings, for work that needs the setting on. */
  const loadEnabledContext = Effect.fnUntraced(function* (threadId: ThreadId) {
    const thread = yield* loadThread(threadId);
    if (thread.archivedAt !== null) {
      return yield* new RepoWorktreeThreadUnavailableError({ threadId, state: "archived" });
    }
    const settings = yield* loadSettings(thread.projectId);
    if (!settings.repoWorktrees) {
      return yield* new RepoWorktreesDisabledError({ projectId: thread.projectId });
    }
    const project = yield* loadProject(thread.projectId);
    return { thread, settings, project };
  });

  const attachedWorktree = Effect.fnUntraced(function* (
    thread: OrchestrationV2AppThread,
    worktreePath: string,
  ) {
    const target = yield* pathIdentity(worktreePath);
    for (const entry of thread.repoWorktrees ?? []) {
      if ((yield* pathIdentity(entry.worktreePath)) === target) return entry;
    }
    return undefined;
  });

  const requireAttached = (thread: OrchestrationV2AppThread, worktreePath: string) =>
    attachedWorktree(thread, worktreePath).pipe(
      Effect.filterOrFail(
        (attached): attached is ThreadRepoWorktree => attached !== undefined,
        () => new RepoWorktreeRequestError({ reason: "not_attached", path: worktreePath }),
      ),
    );

  // A name Git cannot resolve locally makes `worktree add -b` guess a remote
  // branch and create that instead of the new branch, so the start point is
  // always a commit resolved here, with no fetch.
  const resolveLocalBase = Effect.fnUntraced(function* (
    cwd: string,
    baseRef: string,
    hasOrigin: boolean,
    label: string,
  ) {
    const looksLikeOption = baseRef.startsWith("-");
    const resolved = looksLikeOption
      ? { ok: false, stdout: "" }
      : yield* probe(cwd, "resolveBaseRef", [
          "rev-parse",
          "--verify",
          "--quiet",
          `${baseRef}^{commit}`,
        ]);
    if (resolved.ok && resolved.stdout !== "") return resolved.stdout;
    const onOrigin =
      hasOrigin &&
      !looksLikeOption &&
      (yield* probe(cwd, "remoteBaseExists", [
        "show-ref",
        "--verify",
        "--quiet",
        `refs/remotes/origin/${baseRef}`,
      ])).ok;
    return yield* new RepoWorktreeRequestError({
      reason: "base_missing",
      baseRef,
      path: label,
      remote: onOrigin,
    });
  });

  const checkedOutBranch = (worktreePath: string) =>
    probe(worktreePath, "verifyBranch", ["symbolic-ref", "--quiet", "HEAD"]).pipe(
      Effect.map((head) =>
        head.ok && head.stdout.startsWith("refs/heads/")
          ? head.stdout.slice("refs/heads/".length)
          : undefined,
      ),
    );

  const resolveRepository = Effect.fnUntraced(function* (
    workspaceRoot: string,
    repository: string,
  ) {
    const root = yield* realPathOr(workspaceRoot);
    const requested = path.isAbsolute(repository)
      ? repository
      : path.resolve(workspaceRoot, repository);
    const exists = yield* fileSystem.exists(requested).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return yield* new RepoWorktreeRequestError({ reason: "not_a_repository", path: repository });
    }
    const candidate = yield* realPathOr(requested);
    if (!insideOrEqual(root, candidate)) {
      return yield* new RepoWorktreeRequestError({ reason: "outside_project", path: repository });
    }
    const toplevel = yield* probe(candidate, "resolveRepository", ["rev-parse", "--show-toplevel"]);
    if (!toplevel.ok || toplevel.stdout === "") {
      return yield* new RepoWorktreeRequestError({ reason: "not_a_repository", path: repository });
    }
    const repositoryPath = yield* realPathOr(toplevel.stdout);
    if (!insideOrEqual(root, repositoryPath)) {
      return yield* new RepoWorktreeRequestError({ reason: "outside_project", path: repository });
    }
    const commonDir = yield* run(repositoryPath, "resolveRepository", [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]).pipe(Effect.flatMap((result) => realPathOr(result.stdout.trim())));
    const relative = path.relative(root, repositoryPath);
    return {
      repositoryPath,
      commonDir,
      label: relative === "" ? "." : relative.split(path.sep).join("/"),
    };
  });

  const listWorktrees = Effect.fnUntraced(function* (repositoryPath: string) {
    const listed = yield* git.execute({
      operation: "RepoWorktreeService.listWorktrees",
      cwd: repositoryPath,
      args: ["worktree", "list", "--porcelain", "-z"],
      allowNonZeroExit: true,
      timeoutMs: 30_000,
    });
    // Git before 2.36 has no -z for this command.
    const stdout =
      listed.exitCode === 0
        ? listed.stdout
        : (yield* run(repositoryPath, "listWorktrees", [
            "worktree",
            "list",
            "--porcelain",
          ])).stdout.replaceAll("\n", "\0");
    return parseWorktreeList(stdout);
  });

  // Without -z, porcelain v1 quotes paths with control characters and keeps a
  // rename on one line, so each line is one changed file. Lines are counted as
  // they stream, so the count stays exact however large the output is.
  const countChangedFiles = Effect.fnUntraced(function* (
    cwd: string,
    operation: string,
    untrackedFiles: "normal" | "no",
    timeoutMs: number,
  ) {
    let count = 0;
    yield* git.execute({
      operation: `RepoWorktreeService.${operation}`,
      cwd,
      args: ["status", "--porcelain=v1", `--untracked-files=${untrackedFiles}`],
      timeoutMs,
      maxOutputBytes: 4_096,
      appendTruncationMarker: true,
      keepLineCallbacksAfterTruncation: true,
      progress: {
        onStdoutLine: () =>
          Effect.sync(() => {
            count++;
          }),
      },
    });
    return count;
  });

  const allocateWorktreePath = Effect.fnUntraced(function* (
    worktreesDirectory: string,
    repositoryPath: string,
    branch: string,
  ) {
    const root = resolveWorktreesDirectory(
      worktreesDirectory,
      config.worktreesDir,
      path,
      yield* HostProcess.HomeDirectory,
    );
    if (root === null) {
      return yield* new RepoWorktreeRequestError({ reason: "location_invalid" });
    }
    // Same layout as other managed worktrees. A folder already there may belong
    // to another repository with the same name, so it is skipped, never reused.
    const base = path.join(root, path.basename(repositoryPath), branch.replace(/\//g, "-"));
    for (let attempt = 1; attempt <= 50; attempt++) {
      const candidate = attempt === 1 ? base : `${base}-${attempt}`;
      if (!(yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => true)))) {
        return candidate;
      }
    }
    return yield* new RepoWorktreeRequestError({ reason: "path_unavailable", path: base });
  });

  /**
   * Removes a checkout unless a thread has it attached. Callers hold the
   * repository lease, which ensure attaches under, so the answer still holds
   * when Git removes the folder.
   */
  const removeUnattached = Effect.fnUntraced(function* (input: VcsRemoveWorktreeInput) {
    const target = yield* pathIdentity(input.path);
    const attachments = yield* projections
      .getThreadRepoWorktreePaths()
      .pipe(
        Effect.mapError((cause) => new RepoWorktreeReadError({ operation: "attachments", cause })),
      );
    for (const attachment of attachments) {
      if ((yield* pathIdentity(attachment.worktreePath)) === target) {
        return yield* new RepoWorktreeInUseError({
          path: input.path,
          threadId: attachment.threadId,
          threadTitle: attachment.title,
        });
      }
    }
    yield* gitWorkflow.removeWorktree(input);
  });

  const dispatchAttach = Effect.fn("RepoWorktreeService.dispatchAttach")(
    function* (
      threadId: ThreadId,
      repoWorktree: ThreadRepoWorktree,
      options: { readonly relabelOnly?: boolean } = {},
    ) {
      const uuid = yield* random.uuidV4().pipe(Effect.orDie);
      yield* threadManagement.dispatch({
        type: "thread.repo-worktree.attach",
        commandId: CommandId.make(`repo-worktree:attach:${uuid}`),
        threadId,
        repoWorktree,
        ...(options.relabelOnly === true ? { relabelOnly: true } : {}),
      });
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause as Cause.Cause<never>)
            : Effect.fail(
                new RepoWorktreeDispatchError({
                  threadId,
                  operation: "attach",
                  cause: Cause.squash(cause),
                }),
              ),
        ),
      ),
  );

  // The snapshot the run's checkpoints compare against: the baseline of the
  // run in progress, or of the next run when attached between turns.
  const captureAttachBaseline = (threadId: ThreadId, repoWorktree: ThreadRepoWorktree) =>
    threadManagement.getThreadRecords(threadId, ["runs"]).pipe(
      Effect.flatMap(({ runs }) => {
        const open = runs
          .filter((run) => !SETTLED_RUN_STATUSES.has(run.status))
          .map((run) => run.ordinal);
        const ordinalWithinScope =
          open.length > 0
            ? Math.max(0, Math.min(...open) - 1)
            : Math.max(0, ...runs.map((run) => run.ordinal));
        return checkpoints.captureRepositoryBaseline({
          threadId,
          repoWorktree,
          ordinalWithinScope,
          runs,
        });
      }),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause as Cause.Cause<never>)
          : Effect.logWarning("repository worktree baseline was not captured", { threadId }),
      ),
    );

  const ensureLocked = Effect.fnUntraced(function* (
    input: RepoWorktreeEnsureInput,
    context: Effect.Success<ReturnType<typeof loadEnabledContext>>,
    repository: Effect.Success<ReturnType<typeof resolveRepository>>,
  ) {
    const { thread, settings } = context;
    const cwd = repository.repositoryPath;
    const branchRef = `refs/heads/${input.branch}`;
    const valid = yield* probe(cwd, "checkBranchName", [
      "check-ref-format",
      "--branch",
      input.branch,
    ]);
    if (!valid.ok) {
      return yield* new RepoWorktreeRequestError({
        reason: "invalid_branch",
        branch: input.branch,
      });
    }
    const worktrees = yield* listWorktrees(cwd);
    const [main, ...linked] = worktrees;
    const existing = linked.find((entry) => entry.branchRef === branchRef && !entry.prunable);
    // The repository in the folder may itself be a linked worktree of a checkout elsewhere.
    if (
      main?.branchRef === branchRef ||
      (existing !== undefined &&
        (yield* pathIdentity(existing.path)) === (yield* pathIdentity(cwd)))
    ) {
      return yield* new RepoWorktreeRequestError({
        reason: "branch_in_source_checkout",
        branch: input.branch,
        path: cwd,
      });
    }
    const attachedAt = DateTime.formatIso(yield* DateTime.now);

    if (existing !== undefined) {
      const worktreePath = path.resolve(existing.path);
      const uncommittedFiles = yield* countChangedFiles(
        worktreePath,
        "countUncommittedFiles",
        "normal",
        30_000,
      );
      const alreadyAttached = yield* attachedWorktree(thread, worktreePath);
      // An entry whose checkout was switched to this branch is relabeled, so
      // the thread never lists a branch the checkout does not have.
      const repoWorktree: ThreadRepoWorktree =
        alreadyAttached === undefined
          ? {
              repository: repository.label,
              repositoryPath: cwd,
              worktreePath,
              branch: input.branch,
              baseRef: null,
              origin: "reused",
              attachedAt,
            }
          : { ...alreadyAttached, branch: input.branch };
      if (alreadyAttached?.branch !== input.branch) {
        yield* dispatchAttach(thread.id, repoWorktree);
        // Its uncommitted edits predate this thread, so they are the baseline.
        yield* captureAttachBaseline(thread.id, repoWorktree);
      }
      return {
        status: "reused",
        branchCreated: false,
        alreadyAttached: alreadyAttached !== undefined,
        uncommittedFiles,
        startedFromOrigin: false,
        repoWorktree,
      } satisfies RepoWorktreeEnsureResult;
    }

    const localExists = (yield* probe(cwd, "branchExists", [
      "show-ref",
      "--verify",
      "--quiet",
      branchRef,
    ])).ok;
    const hasOrigin = yield* gitWorkflow.remoteExists({ cwd, remoteName: "origin" });
    // The setting only applies where an origin exists; an explicit request
    // without one fails in git instead of silently starting locally.
    const startFromOrigin =
      input.startFromOrigin ?? (settings.newWorktreesStartFromOrigin && hasOrigin);
    if (startFromOrigin && !localExists) {
      yield* gitWorkflow.fetchRemote({ cwd, remoteName: "origin" });
    }
    const remoteExists =
      !localExists &&
      hasOrigin &&
      (yield* probe(cwd, "remoteBranchExists", [
        "show-ref",
        "--verify",
        "--quiet",
        `refs/remotes/origin/${input.branch}`,
      ])).ok;

    let plan: {
      readonly refName: string;
      readonly newRefName?: string;
      readonly baseRefName?: string;
      readonly baseRef: string | null;
      readonly startedFromOrigin: boolean;
    };
    if (localExists || remoteExists) {
      if (input.useExistingBranch !== true) {
        return yield* new RepoWorktreeRequestError({
          reason: "branch_exists",
          branch: input.branch,
          path: repository.label,
          remote: !localExists,
        });
      }
      plan = localExists
        ? { refName: input.branch, baseRef: null, startedFromOrigin: false }
        : {
            // The full name sets origin's branch as upstream, which a commit would not.
            refName: `refs/remotes/origin/${input.branch}`,
            newRefName: input.branch,
            baseRef: `origin/${input.branch}`,
            startedFromOrigin: true,
          };
    } else {
      if (input.useExistingBranch === true) {
        return yield* new RepoWorktreeRequestError({
          reason: "branch_missing",
          branch: input.branch,
          path: repository.label,
        });
      }
      if (input.baseRef === undefined) {
        return yield* new RepoWorktreeRequestError({
          reason: "base_ref_required",
          branch: input.branch,
          path: repository.label,
        });
      }
      const startRef = startFromOrigin
        ? (yield* gitWorkflow.resolveRemoteTrackingCommit({
            cwd,
            refName: input.baseRef,
            fallbackRemoteName: "origin",
          })).commitSha
        : yield* resolveLocalBase(cwd, input.baseRef, hasOrigin, repository.label);
      plan = {
        refName: startRef,
        newRefName: input.branch,
        baseRefName: input.baseRef,
        baseRef: input.baseRef,
        startedFromOrigin: startFromOrigin,
      };
    }

    // A worktree folder deleted outside git still holds its branch; its record
    // only refers to a missing folder, so dropping it loses nothing.
    if (linked.some((entry) => entry.prunable && entry.branchRef === branchRef)) {
      yield* gitWorkflow.pruneWorktrees({ cwd });
    }
    const worktreePath = yield* allocateWorktreePath(
      settings.worktreesDirectory,
      cwd,
      input.branch,
    );

    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const created = yield* restore(
          gitWorkflow.createWorktree(
            {
              cwd,
              refName: plan.refName,
              ...(plan.newRefName === undefined ? {} : { newRefName: plan.newRefName }),
              ...(plan.baseRefName === undefined ? {} : { baseRefName: plan.baseRefName }),
              path: worktreePath,
            },
            { submodules: settings.worktreeSubmodules },
          ),
        );
        const repoWorktree: ThreadRepoWorktree = {
          repository: repository.label,
          repositoryPath: cwd,
          worktreePath: path.resolve(created.worktree.path),
          branch: input.branch,
          baseRef: plan.baseRef,
          origin: "created",
          attachedAt,
        };
        // Already under this repository's lease. An attach that committed
        // despite reporting failure keeps the checkout and its branch.
        const rollback = removeUnattached({
          cwd,
          path: repoWorktree.worktreePath,
          force: true,
        }).pipe(
          Effect.andThen(
            plan.newRefName === undefined
              ? Effect.void
              : Effect.gen(function* () {
                  const created = yield* probe(cwd, "branchExists", [
                    "show-ref",
                    "--verify",
                    "--quiet",
                    branchRef,
                  ]);
                  if (created.ok) {
                    yield* gitWorkflow.deleteLocalBranch({
                      cwd,
                      refName: input.branch,
                      force: true,
                    });
                  }
                }),
          ),
          Effect.ignoreCause({ log: true }),
        );
        // The result names a branch, so it must be the one Git checked out.
        const actualBranch = yield* checkedOutBranch(repoWorktree.worktreePath).pipe(
          Effect.onError(() => rollback),
        );
        if (actualBranch !== input.branch) {
          yield* rollback;
          return yield* new RepoWorktreeRequestError({
            reason: "branch_mismatch",
            branch: input.branch,
            path: repoWorktree.worktreePath,
            ...(actualBranch === undefined ? {} : { actualBranch }),
          });
        }
        // Interrupt-only causes keep the checkout: the attach may have
        // committed, and deleting a worktree the thread lists is worse than
        // leaving one behind.
        yield* dispatchAttach(thread.id, repoWorktree).pipe(
          Effect.onError((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.void : rollback)),
        );
        yield* restore(captureAttachBaseline(thread.id, repoWorktree));
        return {
          status: "created",
          branchCreated: plan.newRefName !== undefined,
          alreadyAttached: false,
          uncommittedFiles: 0,
          startedFromOrigin: plan.startedFromOrigin,
          repoWorktree,
        } satisfies RepoWorktreeEnsureResult;
      }),
    );
  });

  const ensure: RepoWorktreeService["Service"]["ensure"] = Effect.fn("RepoWorktreeService.ensure")(
    function* (input) {
      const context = yield* loadEnabledContext(input.threadId);
      const repository = yield* resolveRepository(context.project.workspaceRoot, input.repository);
      return yield* withRepositoryLease(
        pathKey(repository.commonDir),
        ensureLocked(input, context, repository),
      );
    },
  );

  const removeWorktree: RepoWorktreeService["Service"]["removeWorktree"] = Effect.fn(
    "RepoWorktreeService.removeWorktree",
  )(function* (input) {
    const commonDir = yield* probe(input.cwd, "removeWorktree.commonDir", [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]).pipe(Effect.orElseSucceed(() => ({ ok: false, stdout: "" })));
    const leaseKey = yield* pathIdentity(
      commonDir.ok && commonDir.stdout !== "" ? commonDir.stdout : input.cwd,
    );
    yield* withRepositoryLease(leaseKey, removeUnattached(input));
  });

  const detach: RepoWorktreeService["Service"]["detach"] = Effect.fn("RepoWorktreeService.detach")(
    function* (input) {
      const thread = yield* loadThread(input.threadId);
      const attached = yield* attachedWorktree(thread, input.worktreePath);
      if (attached === undefined) return { detached: false, worktreePath: input.worktreePath };
      const uuid = yield* random.uuidV4().pipe(Effect.orDie);
      yield* threadManagement
        .dispatch({
          type: "thread.repo-worktree.detach",
          commandId: CommandId.make(`repo-worktree:detach:${uuid}`),
          threadId: input.threadId,
          worktreePath: attached.worktreePath,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new RepoWorktreeDispatchError({
                threadId: input.threadId,
                operation: "detach",
                cause,
              }),
          ),
        );
      return { detached: true, worktreePath: attached.worktreePath };
    },
  );

  const recordBranch: RepoWorktreeService["Service"]["recordBranch"] = Effect.fn(
    "RepoWorktreeService.recordBranch",
  )(function* (input) {
    const target = yield* pathIdentity(input.cwd);
    const attachments = yield* projections
      .getThreadRepoWorktreePaths()
      .pipe(
        Effect.mapError((cause) => new RepoWorktreeReadError({ operation: "attachments", cause })),
      );
    const threadIds = new Set<ThreadId>();
    for (const attachment of attachments) {
      if ((yield* pathIdentity(attachment.worktreePath)) === target) {
        threadIds.add(attachment.threadId);
      }
    }
    if (threadIds.size === 0) return;
    // A detached HEAD keeps the branch it was last on.
    const branch = yield* checkedOutBranch(input.cwd);
    if (branch === undefined) return;
    for (const threadId of threadIds) {
      const attached = yield* attachedWorktree(yield* loadThread(threadId), input.cwd);
      if (attached === undefined || attached.branch === branch) continue;
      // Refused when a detach landed first, which leaves nothing to relabel.
      yield* dispatchAttach(threadId, { ...attached, branch }, { relabelOnly: true }).pipe(
        Effect.catchTags({
          RepoWorktreeDispatchError: (error) =>
            Effect.logWarning("repository worktree branch was not relabeled", {
              threadId,
              cause: error.cause,
            }),
        }),
      );
    }
  });

  const repositoryOriginUrl = (cwd: string) =>
    probe(cwd, "originUrl", ["config", "--get", "remote.origin.url"]).pipe(
      Effect.map((result) =>
        result.ok && result.stdout !== "" ? result.stdout.replace(/(\.git)?\/*$/, "") : null,
      ),
    );

  const setSubmoduleCommit: RepoWorktreeService["Service"]["setSubmoduleCommit"] = Effect.fn(
    "RepoWorktreeService.setSubmoduleCommit",
  )(function* (input) {
    const { thread } = yield* loadEnabledContext(input.threadId);
    const parent = yield* requireAttached(thread, input.worktreePath);
    const source = yield* requireAttached(thread, input.sourceWorktreePath);
    // One pin at a time per parent, so two calls cannot interleave checkouts.
    return yield* repositoryLocks.withLock(
      `submodules:${pathKey(parent.worktreePath)}`,
      pinSubmodule(input, parent, source),
    );
  });

  const pinSubmodule = Effect.fnUntraced(function* (
    input: RepoWorktreeSetSubmoduleInput,
    parent: ThreadRepoWorktree,
    source: ThreadRepoWorktree,
  ) {
    const submodulePath = input.submodulePath.replace(/\\/g, "/").replace(/\/+$/, "");
    if (
      submodulePath === "" ||
      path.isAbsolute(submodulePath) ||
      submodulePath.split("/").some((segment) => segment === ".." || segment === ".")
    ) {
      return yield* new RepoWorktreeRequestError({
        reason: "not_a_submodule",
        path: input.submodulePath,
      });
    }

    // The index entry, not the checkout, is what the parent records.
    const indexEntry = (yield* run(parent.worktreePath, "readGitlink", [
      "ls-files",
      "--stage",
      "-z",
      "--",
      submodulePath,
    ])).stdout
      .split("\0")
      .map((record) => /^(\d+) ([0-9a-f]+) \d+\t(.*)$/.exec(record))
      .find((match) => match !== null && match[3] === submodulePath);
    if (indexEntry == null || indexEntry[1] !== "160000") {
      return yield* new RepoWorktreeRequestError({
        reason: "not_a_submodule",
        path: submodulePath,
      });
    }
    const previousCommit = indexEntry[2] ?? null;

    const commit = (yield* run(source.worktreePath, "resolveCommit", [
      "rev-parse",
      "--verify",
      `${input.commit ?? "HEAD"}^{commit}`,
    ])).stdout.trim();

    const submoduleDir = path.join(parent.worktreePath, ...submodulePath.split("/"));
    const isCheckout = Effect.gen(function* () {
      const toplevel = yield* probe(submoduleDir, "submoduleToplevel", [
        "rev-parse",
        "--show-toplevel",
      ]);
      return (
        toplevel.ok &&
        sameWorktree(yield* realPathOr(toplevel.stdout), yield* realPathOr(submoduleDir))
      );
    }).pipe(Effect.orElseSucceed(() => false));
    if (!(yield* isCheckout)) {
      yield* run(parent.worktreePath, "initSubmodule", [
        "submodule",
        "update",
        "--init",
        "--",
        submodulePath,
      ]);
    }

    // Same history, or the same origin, before any objects move between them.
    const related =
      previousCommit !== null &&
      (yield* probe(source.worktreePath, "relatedHistory", [
        "cat-file",
        "-e",
        `${previousCommit}^{commit}`,
      ])).ok;
    if (!related) {
      const [submoduleOrigin, sourceOrigin] = yield* Effect.all([
        repositoryOriginUrl(submoduleDir),
        repositoryOriginUrl(source.worktreePath),
      ]);
      if (submoduleOrigin === null || submoduleOrigin !== sourceOrigin) {
        return yield* new RepoWorktreeRequestError({
          reason: "source_mismatch",
          path: submodulePath,
        });
      }
    }

    if ((yield* countChangedFiles(submoduleDir, "submoduleChanges", "no", 60_000)) > 0) {
      return yield* new RepoWorktreeRequestError({
        reason: "submodule_changes",
        path: submodulePath,
      });
    }

    const present = (yield* probe(submoduleDir, "hasCommit", [
      "cat-file",
      "-e",
      `${commit}^{commit}`,
    ])).ok;
    if (!present) {
      // A one-off fetch from the local repository: no remote is added and no
      // URL changes, so the parent's submodule keeps pointing at its origin.
      const sourceCommonDir = (yield* run(source.worktreePath, "sourceCommonDir", [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ])).stdout.trim();
      yield* run(submoduleDir, "fetchLocalCommit", [
        "fetch",
        "--quiet",
        "--no-tags",
        "--no-write-fetch-head",
        sourceCommonDir,
        commit,
      ]);
    }
    // The status check skips ignored files, so Git must refuse to overwrite them.
    yield* run(submoduleDir, "checkoutCommit", [
      "checkout",
      "--quiet",
      "--no-overwrite-ignore",
      "--detach",
      commit,
    ]);
    const stage = input.stage ?? true;
    if (stage) {
      yield* run(parent.worktreePath, "stageGitlink", ["add", "--", submodulePath]);
    }
    yield* gitWorkflow.invalidateStatus(parent.worktreePath);
    return {
      worktreePath: parent.worktreePath,
      submodulePath,
      commit,
      previousCommit,
      fetched: !present,
      staged: stage,
    } satisfies RepoWorktreeSetSubmoduleResult;
  });

  return RepoWorktreeService.of({
    ensure,
    detach,
    recordBranch,
    setSubmoduleCommit,
    removeWorktree,
  });
});

export const layer = Layer.effect(RepoWorktreeService, make);
