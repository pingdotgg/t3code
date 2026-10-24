import { ThreadId, TerminalCwdNotFoundError, type ProjectId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { makeIsManagedWorktreePath } from "../worktreesDirectory.ts";
import { withWorkspaceLease } from "./workspaceLease.ts";

/**
 * Storage cleanup removes idle worktrees while their threads stay usable, so
 * anything that is about to run in one puts it back first. Failures are logged,
 * not raised: the caller's own cwd check reports the missing folder.
 */
interface WorktreeThread {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly worktreePath: string | null;
  readonly branch: string | null;
}

export const makeRestoreMissingWorktree = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const projects = yield* ProjectService.ProjectService;
  const isManagedWorktreePath = yield* makeIsManagedWorktreePath;

  return Effect.fn("restoreMissingWorktree")(function* (thread: WorktreeThread) {
    const { worktreePath, branch } = thread;
    if (worktreePath === null || branch === null) return;
    const exists = yield* fileSystem.exists(worktreePath).pipe(Effect.orElseSucceed(() => true));
    if (exists || !(yield* isManagedWorktreePath(worktreePath))) return;
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
    yield* gitWorkflow.pruneWorktrees({ cwd: project.workspaceRoot }).pipe(
      Effect.andThen(
        gitWorkflow.createWorktree({
          cwd: project.workspaceRoot,
          refName: branch,
          path: worktreePath,
        }),
      ),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("failed to recreate missing worktree", {
              threadId: thread.id,
              worktreePath,
              cause: Cause.pretty(cause),
            }),
      ),
    );
  });
});

const isCwdNotFound = Schema.is(TerminalCwdNotFoundError);

/**
 * The terminal manager can't recreate worktrees itself: creating one runs setup
 * scripts in a terminal. A terminal launch whose worktree is gone puts it back
 * here and retries once.
 */
export const makeRetryAfterRestoringWorktree = Effect.fn("makeRetryAfterRestoringWorktree")(
  function* <LookupError>(
    getThreadShell: (threadId: ThreadId) => Effect.Effect<WorktreeThread | null, LookupError>,
  ) {
    const path = yield* Path.Path;
    const restoreMissingWorktree = yield* makeRestoreMissingWorktree;
    return Effect.fn("restoreMissingWorktree.retryLaunch")(function* <A, E, R>(
      threadId: string,
      launch: Effect.Effect<A, E, R>,
    ) {
      return yield* launch.pipe(
        Effect.catchIf(isCwdNotFound, (error) =>
          getThreadShell(ThreadId.make(threadId)).pipe(
            Effect.orElseSucceed(() => null),
            Effect.flatMap((thread) =>
              thread?.worktreePath == null
                ? Effect.fail(error)
                : withWorkspaceLease(
                    path.resolve(thread.worktreePath),
                    restoreMissingWorktree(thread),
                  ).pipe(Effect.andThen(launch)),
            ),
          ),
        ),
      );
    });
  },
);
