import { ThreadId, type ProjectId, type TerminalCwdNotFoundError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { makeIsManagedWorktreePath } from "../worktreesDirectory.ts";
import { isWithinRoot } from "./KnownWorkspaces.ts";
import { withWorkspaceLease } from "./workspaceLease.ts";
import { TerminalCwdRecovery } from "../terminal/Manager.ts";

export class WorktreeRecreateError extends Schema.TaggedError<WorktreeRecreateError>()(
  "WorktreeRecreateError",
  {
    worktreePath: Schema.String,
    branch: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not recreate the worktree for branch '${this.branch}' at ${this.worktreePath}.`;
  }
}

class WorktreeRecreateNoBaseError extends Schema.TaggedError<WorktreeRecreateNoBaseError>()(
  "WorktreeRecreateNoBaseError",
  { worktreePath: Schema.String, branch: Schema.String },
) {
  override get message(): string {
    return `Could not recreate branch '${this.branch}' at ${this.worktreePath}: the project workspace has no commit to start it from.`;
  }
}

// `git worktree remove` skips pnpm junctions on Windows, leaving these behind without a checkout.
const LEFTOVER_WORKTREE_ENTRIES = new Set(["node_modules", ".next"]);

interface WorktreeThread {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly worktreePath: string | null;
  readonly branch: string | null;
}

export const makeRestoreMissingWorktree = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const projects = yield* ProjectService.ProjectService;
  const isManagedWorktreePath = yield* makeIsManagedWorktreePath;

  // Only folders holding nothing but leftovers are cleared, never user files.
  const isLeftoverFolder = (worktreePath: string) =>
    fileSystem.exists(path.join(worktreePath, ".git")).pipe(
      Effect.flatMap((hasGit) =>
        hasGit
          ? Effect.succeed(false)
          : fileSystem.readDirectory(worktreePath).pipe(
              Effect.flatMap((entries) =>
                Effect.forEach(entries, (entry) =>
                  LEFTOVER_WORKTREE_ENTRIES.has(entry)
                    ? fileSystem
                        .stat(path.join(worktreePath, entry))
                        .pipe(Effect.map((info) => info.type === "Directory"))
                    : Effect.succeed(false),
                ),
              ),
              Effect.map((leftovers) => leftovers.every(Boolean)),
            ),
      ),
      Effect.orElseSucceed(() => false),
    );

  const resolveRecreateBase = Effect.fn("restoreMissingWorktree.resolveRecreateBase")(function* (
    cwd: string,
    remoteName: string | null,
  ) {
    // Recovery can follow an external checkout, before the status cache expires.
    yield* gitWorkflow.invalidateLocalStatus(cwd);
    const { refName: currentBranch } = yield* gitWorkflow.localStatus({ cwd });
    if (currentBranch !== null) {
      const refName = `refs/heads/${currentBranch}`;
      return { refName, baseRefName: refName };
    }
    const remoteHead = `refs/remotes/${remoteName}/HEAD`;
    if (remoteName !== null && (yield* gitWorkflow.hasCommit({ cwd, refName: remoteHead }))) {
      const { commitSha } = yield* gitWorkflow.resolveRemoteTrackingCommit({
        cwd,
        refName: "HEAD",
        fallbackRemoteName: remoteName,
      });
      // Start from the commit so the thread branch does not track the default branch.
      return { refName: commitSha, baseRefName: remoteHead };
    }
    if (yield* gitWorkflow.hasCommit({ cwd, refName: "HEAD" })) {
      return { refName: "HEAD", baseRefName: undefined };
    }
    return null;
  });

  const recreateMissingWorktree = Effect.fn("restoreMissingWorktree.recreate")(function* (input: {
    readonly cwd: string;
    readonly worktreePath: string;
    readonly branch: string;
  }) {
    const { cwd, worktreePath, branch } = input;
    yield* gitWorkflow.pruneWorktrees({ cwd });
    const localBranchNames = yield* gitWorkflow.listLocalBranchNames(cwd);
    if (localBranchNames.includes(branch)) {
      yield* gitWorkflow.createWorktree({ cwd, refName: branch, path: worktreePath });
      return;
    }
    const remoteName = yield* gitWorkflow
      .resolvePrimaryRemoteName(cwd)
      .pipe(Effect.orElseSucceed(() => null));
    // Push keeps the tracking ref current, so recovery reads it without fetching.
    const pushedRef = remoteName === null ? null : `refs/remotes/${remoteName}/${branch}`;
    if (pushedRef !== null && (yield* gitWorkflow.hasCommit({ cwd, refName: pushedRef }))) {
      yield* gitWorkflow.createWorktree({
        cwd,
        refName: pushedRef,
        newRefName: branch,
        path: worktreePath,
      });
      return;
    }
    const base = yield* resolveRecreateBase(cwd, remoteName);
    if (base === null) {
      return yield* new WorktreeRecreateNoBaseError({ worktreePath, branch });
    }
    yield* gitWorkflow.createWorktree({
      cwd,
      refName: base.refName,
      newRefName: branch,
      ...(base.baseRefName === undefined ? {} : { baseRefName: base.baseRefName }),
      path: worktreePath,
    });
  });

  return Effect.fn("restoreMissingWorktree")(function* (thread: WorktreeThread) {
    const { worktreePath, branch } = thread;
    if (worktreePath === null || branch === null) return;
    const exists = yield* fileSystem.exists(worktreePath).pipe(Effect.orElseSucceed(() => true));
    const leftover = exists && (yield* isLeftoverFolder(worktreePath));
    if ((exists && !leftover) || !(yield* isManagedWorktreePath(worktreePath))) return;
    const project = yield* projects.getById(thread.projectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );
    if (project === undefined) return;
    yield* Effect.logWarning("recreating missing worktree", {
      threadId: thread.id,
      worktreePath,
      branch,
    });
    // `git worktree add` refuses a non-empty target.
    yield* (leftover ? fileSystem.remove(worktreePath, { recursive: true }) : Effect.void).pipe(
      Effect.andThen(recreateMissingWorktree({ cwd: project.workspaceRoot, worktreePath, branch })),
      Effect.mapError((cause) =>
        cause._tag === "WorktreeRecreateNoBaseError"
          ? cause
          : new WorktreeRecreateError({ worktreePath, branch, cause }),
      ),
    );
  });
});

export class ThreadWorktreeRestore extends Context.Service<
  ThreadWorktreeRestore,
  {
    readonly restore: (
      thread: WorktreeThread,
    ) => Effect.Effect<void, WorktreeRecreateError | WorktreeRecreateNoBaseError>;
  }
>()("t3/workspace/restoreMissingWorktree/ThreadWorktreeRestore") {}

// Turn start restores under the same lease, so concurrent restores see each other's worktree.
export const layerThreadWorktreeRestore = Layer.effect(
  ThreadWorktreeRestore,
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const restore = yield* makeRestoreMissingWorktree;
    return {
      restore: Effect.fn("ThreadWorktreeRestore.restore")(function* (thread: WorktreeThread) {
        return yield* thread.worktreePath === null
          ? restore(thread)
          : withWorkspaceLease(path.resolve(thread.worktreePath), restore(thread));
      }),
    };
  }),
);

// Worktree setup uses terminals, so recovery must stay outside TerminalManager.
export const makePrepareTerminalLaunch = Effect.fn(
  "restoreMissingWorktree.makePrepareTerminalLaunch",
)(function* <LookupError>(
  getThreadShell: (threadId: ThreadId) => Effect.Effect<WorktreeThread | null, LookupError>,
) {
  const path = yield* Path.Path;
  const restoreMissingWorktree = yield* makeRestoreMissingWorktree;
  return Effect.fn("restoreMissingWorktree.prepareTerminalLaunch")(function* <
    Input extends {
      readonly threadId: string;
      readonly cwd?: string | undefined;
      readonly worktreePath?: string | null | undefined;
    },
  >(input: Input) {
    const thread = yield* getThreadShell(ThreadId.make(input.threadId)).pipe(
      Effect.orElseSucceed(() => null),
    );
    const worktreePath = thread?.worktreePath ?? null;
    if (
      thread === null ||
      worktreePath === null ||
      !isWithinRoot(path, path.resolve(input.cwd ?? worktreePath), worktreePath)
    ) {
      return { input, recover: TerminalCwdRecovery.defaultValue() };
    }
    const recover = (error: TerminalCwdNotFoundError) =>
      restoreMissingWorktree(thread).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("failed to recreate missing worktree", {
            threadId: thread.id,
            worktreePath,
            cause,
          }).pipe(Effect.andThen(Effect.fail(error))),
        ),
      );
    // The lease must cover the worktree root, even when the terminal opens in a subdirectory.
    return { input: { ...input, worktreePath }, recover };
  });
});
