import * as NodeCrypto from "node:crypto";
import {
  GitCommandError,
  OrchestrationDispatchCommandError,
  type DispatchResult,
  type OrchestrationCommand,
  type VcsRemoveWorktreeInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";

const locks = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();

/** Cleanup retries may arrive long after deletion, when another thread uses the files. */
export const removeUnusedWorktree = Effect.fn("removeUnusedWorktree")(function* (
  input: VcsRemoveWorktreeInput,
  remove: Effect.Effect<void, GitCommandError>,
) {
  const path = yield* Path.Path;
  const snapshots = yield* ProjectionSnapshotQuery;
  const error = (detail: string) =>
    new GitCommandError({
      operation: "removeWorktree",
      command: "git worktree remove",
      cwd: input.cwd,
      detail,
    });
  const engine = yield* OrchestrationEngineService;
  return yield* engine.withWorktreeCleanup(
    [input.path],
    Effect.gen(function* () {
      const snapshot = yield* snapshots
        .getCommandReadModel()
        .pipe(
          Effect.mapError(() => error("Could not verify worktree references. Files were kept.")),
        );
      const target = path.resolve(input.path);
      if (
        snapshot.threads.some(
          (thread) =>
            thread.deletedAt === null &&
            thread.worktreePath !== null &&
            path.resolve(thread.worktreePath) === target,
        )
      ) {
        return yield* error("This worktree is still used by a thread. Files were kept.");
      }
      yield* remove;
    }),
  );
});

/** Keep all files (including ignored files and the Git index) until deletion commits.
 * A stable staging path also lets a retry restore a worktree after a server crash.
 */
export const withThreadWorktreeDeletion = Effect.fn("withThreadWorktreeDeletion")(function* (
  command: Extract<OrchestrationCommand, { type: "thread.delete" }>,
  commit: (
    worktreeStaged: boolean,
  ) => Effect.Effect<DispatchResult, OrchestrationDispatchCommandError>,
) {
  if (!command.deleteWorktreePath) return yield* commit(false);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver;
  const snapshots = yield* ProjectionSnapshotQuery;
  const original = path.resolve(command.deleteWorktreePath);
  const key = NodeCrypto.createHash("sha256").update(original).digest("hex").slice(0, 24);
  const staged = path.join(path.dirname(original), `.t3-delete-${key}`);
  const lock = locks.get(key) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
  lock.users++;
  locks.set(key, lock);
  return yield* Effect.gen(function* () {
    const snapshot = yield* snapshots.getCommandReadModel();
    const thread = snapshot.threads.find(
      (entry) => entry.id === command.threadId && entry.deletedAt === null,
    );
    if (!thread || thread.worktreePath === null || path.resolve(thread.worktreePath) !== original) {
      return yield* new OrchestrationDispatchCommandError({
        message: "The thread's worktree changed. Refresh and try deleting it again.",
      });
    }
    const project = snapshot.projects.find((entry) => entry.id === thread.projectId);
    if (!project)
      return yield* new OrchestrationDispatchCommandError({
        message: "The thread's project could not be found.",
      });
    const cwd = project.workspaceRoot;
    const move = (from: string, to: string) =>
      git.execute({
        operation: "thread.delete.move-worktree",
        cwd,
        args: ["worktree", "move", "--", from, to],
        timeoutMs: 300_000,
      });
    const restore = Effect.gen(function* () {
      if (!(yield* fs.exists(staged))) return;
      if (yield* fs.exists(original))
        return yield* new OrchestrationDispatchCommandError({
          message: `Worktree recovery could not replace ${original}. Your files are preserved at ${staged}.`,
        });
      // A process can stop between the directory move and Git updating its pointers.
      yield* git.execute({
        operation: "thread.delete.repair-worktree",
        cwd,
        args: ["worktree", "repair", "--", staged],
      });
      yield* move(staged, original);
    });
    yield* restore;
    if (
      snapshot.threads.some(
        (entry) =>
          entry.id !== thread.id &&
          entry.deletedAt === null &&
          entry.worktreePath !== null &&
          path.resolve(entry.worktreePath) === original,
      )
    ) {
      return yield* commit(false);
    }
    // Already removed externally: the ordinary delete remains safe and retryable.
    if (!(yield* fs.exists(original))) return yield* commit(false);
    const result = yield* Effect.gen(function* () {
      yield* move(original, staged);
      return yield* commit(true);
    }).pipe(Effect.exit);
    if (Exit.isFailure(result)) {
      const recovery = yield* restore.pipe(Effect.exit);
      if (Exit.isFailure(recovery))
        return yield* new OrchestrationDispatchCommandError({
          message: `Thread deletion failed and automatic worktree recovery failed. Your files are preserved at ${staged}; restore them before retrying.`,
          cause: recovery.cause,
        });
      return yield* Effect.failCause(result.cause);
    }
    const engine = yield* OrchestrationEngineService;
    return yield* engine.withWorktreeCleanup(
      [original, staged],
      Effect.gen(function* () {
        // Dispatch can replay a receipt for an earlier incarnation. Only remove files
        // after an authoritative read confirms the current thread and references are gone.
        const committed = yield* snapshots.getCommandReadModel().pipe(Effect.exit);
        const pendingCleanup = (retryable: boolean): DispatchResult => ({
          ...result.value,
          worktreeCleanupPending: { cwd, path: staged, retryable },
        });
        if (Exit.isFailure(committed)) return pendingCleanup(false);
        const survivors = committed.value.threads.filter((entry) => entry.deletedAt === null);
        const stagedInUse = survivors.some(
          (entry) => entry.worktreePath !== null && path.resolve(entry.worktreePath) === staged,
        );
        if (survivors.some((entry) => entry.id === command.threadId)) {
          if (!stagedInUse) yield* restore;
          return yield* new OrchestrationDispatchCommandError({
            message:
              "The current thread was not deleted. Its files were kept; refresh before retrying.",
          });
        }
        // A new thread can have selected the staged checkout from Git's worktree list.
        // Keep its path intact, without offering destructive cleanup for shared files.
        if (stagedInUse) return result.value;
        if (
          survivors.some(
            (entry) => entry.worktreePath !== null && path.resolve(entry.worktreePath) === original,
          )
        ) {
          const recovery = yield* restore.pipe(Effect.exit);
          return Exit.isFailure(recovery) ? pendingCleanup(false) : result.value;
        }
        // The thread is committed as deleted. A cleanup error must not masquerade as
        // a failed deletion; return the preserved staging path for an explicit retry.
        const cleanup = yield* git
          .removeWorktree({ cwd, path: staged, force: true })
          .pipe(Effect.exit);
        if (Exit.isFailure(cleanup)) {
          yield* Effect.logWarning("Deleted thread has pending worktree cleanup", {
            threadId: command.threadId,
            cwd,
            path: staged,
          });
          return pendingCleanup(true);
        }
        return result.value;
      }),
    );
  }).pipe(
    Effect.uninterruptible,
    lock.semaphore.withPermits(1),
    Effect.ensuring(
      Effect.sync(() => {
        if (--lock.users === 0) locks.delete(key);
      }),
    ),
  );
});
