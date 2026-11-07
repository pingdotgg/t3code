import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { makeIsManagedWorktreePath } from "../worktreesDirectory.ts";
import * as ProjectService from "./ProjectService.ts";

/** The directory a thread works in, or undefined when the thread or its project is gone. */
export const threadWorkspaceRoot = Effect.fn("threadWorkspaceRoot")(
  function* (threadId: ThreadId) {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const projects = yield* ProjectService.ProjectService;
    const shell = yield* threads.getThreadShell(threadId);
    if (shell === null) return undefined;
    if (shell.worktreePath) return shell.worktreePath;
    return Option.getOrUndefined(yield* projects.getById(shell.projectId))?.workspaceRoot;
  },
  Effect.orElseSucceed(() => undefined),
);

/**
 * Where to scan `cwd`'s workspace inventory. A thread's removed managed worktree scans its
 * project, which turn start recreates the worktree from.
 */
export const workspaceScanDirectory = Effect.fn("workspaceScanDirectory")(
  function* (cwd: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    if (yield* fileSystem.exists(cwd).pipe(Effect.orElseSucceed(() => true))) return cwd;
    const isManagedWorktreePath = yield* makeIsManagedWorktreePath;
    if (!(yield* isManagedWorktreePath(cwd))) return cwd;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const projects = yield* ProjectService.ProjectService;
    const snapshot = yield* Effect.flatten(threads.readShellSnapshot({ worktreePath: cwd }));
    const thread = [...snapshot.threads, ...snapshot.archivedThreads].find(
      (candidate) => candidate.branch !== null,
    );
    if (thread === undefined) return cwd;
    return Option.getOrUndefined(yield* projects.getById(thread.projectId))?.workspaceRoot ?? cwd;
  },
  (effect, cwd) => Effect.orElseSucceed(effect, () => cwd),
);
