import type {
  OrchestrationCommand,
  OrchestrationProject,
  OrchestrationThread,
} from "@t3tools/contracts";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";

import { canonicalizeWorktreePath, resolveGitWorktreeRoot } from "../git/worktreePaths.ts";
import { runProcess } from "../processRunner.ts";
import { WorkspaceOwnershipConflict } from "../persistence/Services/WorkspaceOwnership.ts";
import type { WorkspaceOwnershipRepositoryShape } from "../persistence/Services/WorkspaceOwnership.ts";
import type { WorktreeCleanupJobRepositoryShape } from "../persistence/Services/WorktreeCleanupJobs.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";

export interface WorkspaceAdmissionDeps {
  readonly findThread: (threadId: string) => OrchestrationThread | undefined;
  readonly findProject: (projectId: string) => OrchestrationProject | undefined;
  readonly claimOwnership: WorkspaceOwnershipRepositoryShape["claim"];
  readonly hasCleanupReservationByPath: WorktreeCleanupJobRepositoryShape["hasReservationByPath"];
}

/**
 * Single owner of workspace admission: which worktree path a command targets,
 * isolated-workspace allocation, ownership claims, and cleanup reservations.
 * Previously six closures inside the orchestration engine's dispatch path;
 * loops keep their shape, but every rule about "whose checkout may a command
 * write" now lives behind this narrow interface. The engine supplies live
 * read-model accessors; unit tests supply fakes without booting SQLite.
 */
export function commandWorktreePath(command: OrchestrationCommand): string | null {
  switch (command.type) {
    case "thread.create":
      return command.worktreePath;
    case "thread.meta.update":
      return command.worktreePath ?? null;
    case "thread.workspace.handoff":
      return command.worktreePath;
    default:
      return null;
  }
}

export function cleanupWorktreePath(
  command: OrchestrationCommand,
  threads: ReadonlyArray<OrchestrationThread>,
): string | null {
  const directPath = commandWorktreePath(command);
  if (directPath !== null) {
    return directPath;
  }
  switch (command.type) {
    case "thread.unarchive":
    case "thread.queued-turn.create":
    case "thread.queued-turn.dispatch":
      return threads.find((thread) => thread.id === command.threadId)?.worktreePath ?? null;
    case "thread.turn.start":
      return (
        threads.find((thread) => thread.id === command.threadId)?.worktreePath ??
        command.bootstrap?.createThread?.worktreePath ??
        null
      );
    default:
      return null;
  }
}

export const canonicalizeCommandWorktree = Effect.fn("canonicalizeCommandWorktree")(function* (
  command: OrchestrationCommand,
) {
  const worktreePath = commandWorktreePath(command);
  if (worktreePath === null) {
    return command;
  }
  const canonicalPath = yield* Effect.promise(() => canonicalizeWorktreePath(worktreePath));
  switch (command.type) {
    case "thread.create":
    case "thread.meta.update":
    case "thread.workspace.handoff":
      return { ...command, worktreePath: canonicalPath };
    default:
      return command;
  }
});

export const prepareIsolatedWorkspace = Effect.fn("prepareIsolatedWorkspace")(function* (
  command: OrchestrationCommand,
  projectWorkspaceRoot: string | undefined,
  thread: OrchestrationThread | undefined,
) {
  const isExecutionCommand =
    command.type === "thread.create" ||
    command.type === "thread.turn.start" ||
    command.type === "thread.queued-turn.dispatch";
  // handoff/meta.update keep the full path below: their project-checkout
  // rejection depends on the Git probing. Every other non-execution command
  // (notably high-volume activity appends) ignores all probed values, so
  // return before any filesystem/Git work: each probe costs a subprocess,
  // and under load those subprocesses serialize on the dispatch path.
  const needsWorkspacePreparation =
    isExecutionCommand ||
    command.type === "thread.workspace.handoff" ||
    command.type === "thread.meta.update";
  if (!needsWorkspacePreparation) {
    return { command, worktreePath: null, branch: null, honoredProjectCheckout: false };
  }
  const createThread =
    command.type === "thread.create"
      ? command
      : command.type === "thread.turn.start"
        ? command.bootstrap?.createThread
        : undefined;
  if (
    (command.type === "thread.turn.start" || command.type === "thread.queued-turn.dispatch") &&
    thread === undefined &&
    createThread === undefined
  ) {
    return { command, worktreePath: null, branch: null, honoredProjectCheckout: false };
  }
  const requestedPath =
    createThread?.worktreePath ??
    (command.type === "thread.turn.start" || command.type === "thread.queued-turn.dispatch"
      ? (thread?.workspaceBinding?.worktreePath ?? thread?.worktreePath)
      : command.type === "thread.workspace.handoff"
        ? command.worktreePath
        : command.type === "thread.meta.update"
          ? command.worktreePath
          : undefined);
  const projectRoot =
    projectWorkspaceRoot === undefined
      ? undefined
      : yield* Effect.promise(() => canonicalizeWorktreePath(projectWorkspaceRoot));
  const gitRoot =
    projectRoot === undefined
      ? null
      : yield* Effect.promise(() => resolveGitWorktreeRoot(projectRoot));

  const canonicalRequested =
    requestedPath === null || requestedPath === undefined
      ? null
      : yield* Effect.promise(() => canonicalizeWorktreePath(requestedPath));
  // An explicit project-checkout path in the current creation request (the
  // client sent a concrete directory instead of null) means the user chose
  // "Current checkout": honor it instead of allocating an isolated
  // worktree. Follow-up turns without a creation request are honored only
  // when the thread's persisted binding carries the project-checkout scope
  // recorded below; legacy root bindings without that scope keep isolating
  // so existing threads can never silently gain main-checkout writes.
  const isFreshCheckoutRequest = typeof createThread?.worktreePath === "string";
  const isPersistedCheckoutRequest =
    createThread === undefined &&
    (command.type === "thread.turn.start" || command.type === "thread.queued-turn.dispatch") &&
    thread?.workspaceBinding?.workspaceScope === "project-checkout";
  if (canonicalRequested !== null) {
    const requestedRoot = yield* Effect.promise(() => resolveGitWorktreeRoot(canonicalRequested));
    const isProjectCheckout =
      (requestedRoot !== null && requestedRoot === gitRoot) ||
      (requestedRoot === null && projectRoot === canonicalRequested);
    if (isProjectCheckout && (isFreshCheckoutRequest || isPersistedCheckoutRequest)) {
      return {
        command,
        worktreePath: canonicalRequested,
        branch: createThread?.branch ?? thread?.branch ?? null,
        honoredProjectCheckout: true,
      };
    }
    if (isProjectCheckout && gitRoot !== null) {
      // Treat legacy/root bindings as an isolation request. This preserves
      // the user's turn and recovery path while ensuring the human checkout
      // is never admitted as the writer's workspace.
    } else if (isProjectCheckout) {
      return yield* new OrchestrationCommandInvariantError({
        commandType: command.type,
        detail:
          "The project checkout is reserved for the human. Choose or create an isolated worktree; T3 will not write the main checkout.",
      });
    } else {
      return {
        command,
        worktreePath: canonicalRequested,
        branch: createThread?.branch ?? null,
        honoredProjectCheckout: false,
      };
    }
  }

  if (!isExecutionCommand) {
    // handoff/meta.update without a path involved: nothing to allocate,
    // honor, or reject. Execution commands always carry a threadId and
    // continue to isolated allocation below.
    return {
      command,
      worktreePath: null,
      branch: null,
      honoredProjectCheckout: false,
    };
  }

  const threadId: string = command.threadId;
  if (gitRoot === null) {
    return yield* new OrchestrationCommandInvariantError({
      commandType: command.type,
      detail:
        "This legacy or non-Git workspace has no durable isolated checkout. Choose an explicit exclusive directory and retry; T3 will not fall back to the project root.",
    });
  }
  const repositoryKey = createHash("sha256").update(gitRoot).digest("hex").slice(0, 16);
  const threadWorkspaceKey = createHash("sha256").update(threadId).digest("hex");
  const sourceBranch =
    createThread?.sourceBranch ?? createThread?.branch ?? thread?.branch ?? "HEAD";
  const branch = `t3/thread/${threadWorkspaceKey.slice(0, 24)}`;
  const worktreePath = path.join(
    path.dirname(gitRoot),
    ".t3-thread-workspaces",
    repositoryKey,
    threadWorkspaceKey,
  );
  yield* Effect.tryPromise({
    try: async () => {
      await mkdir(path.dirname(worktreePath), { recursive: true });
      const existing = await runProcess(
        "git",
        ["-C", worktreePath, "rev-parse", "--show-toplevel"],
        {
          allowNonZeroExit: true,
          maxBufferBytes: 16 * 1024,
          timeoutMs: 5_000,
        },
      );
      if (existing.code === 0) {
        const [existingCommonDir, expectedCommonDir, existingBranch] = await Promise.all([
          runProcess("git", ["-C", worktreePath, "rev-parse", "--git-common-dir"], {
            allowNonZeroExit: true,
            maxBufferBytes: 16 * 1024,
            timeoutMs: 5_000,
          }),
          runProcess("git", ["-C", gitRoot, "rev-parse", "--git-common-dir"], {
            allowNonZeroExit: false,
            maxBufferBytes: 16 * 1024,
            timeoutMs: 5_000,
          }),
          runProcess("git", ["-C", worktreePath, "symbolic-ref", "--short", "-q", "HEAD"], {
            allowNonZeroExit: true,
            maxBufferBytes: 16 * 1024,
            timeoutMs: 5_000,
          }),
        ]);
        if (existingCommonDir.code !== 0 || existingBranch.code !== 0) {
          throw new Error("existing workspace is not a checked-out Git worktree");
        }
        const canonicalCommonDir = await canonicalizeWorktreePath(
          path.resolve(worktreePath, existingCommonDir.stdout.trim()),
        );
        const canonicalExpectedCommonDir = await canonicalizeWorktreePath(
          path.resolve(gitRoot, expectedCommonDir.stdout.trim()),
        );
        if (
          canonicalCommonDir !== canonicalExpectedCommonDir ||
          existingBranch.stdout.trim() !== branch
        ) {
          throw new Error(
            `existing workspace belongs to common Git directory '${canonicalCommonDir}' and branch '${existingBranch.stdout.trim()}', expected '${canonicalExpectedCommonDir}' and '${branch}'`,
          );
        }
        return;
      }
      const sourceRevision =
        createThread?.sourceWorktreePath === undefined
          ? sourceBranch
          : (
              await runProcess(
                "git",
                ["-C", createThread.sourceWorktreePath, "rev-parse", "HEAD"],
                {
                  allowNonZeroExit: true,
                  maxBufferBytes: 16 * 1024,
                  timeoutMs: 5_000,
                },
              )
            ).stdout.trim();
      if (!sourceRevision) {
        throw new Error(
          `could not resolve source revision from '${createThread?.sourceWorktreePath ?? sourceBranch}'`,
        );
      }
      const existingBranch = await runProcess(
        "git",
        ["-C", gitRoot, "show-ref", "--verify", `refs/heads/${branch}`],
        {
          allowNonZeroExit: true,
          maxBufferBytes: 16 * 1024,
          timeoutMs: 5_000,
        },
      );
      const worktreeArguments =
        existingBranch.code === 0
          ? ["-C", gitRoot, "worktree", "add", worktreePath, branch]
          : ["-C", gitRoot, "worktree", "add", "-b", branch, worktreePath, sourceRevision];
      const result = await runProcess("git", worktreeArguments, {
        allowNonZeroExit: true,
        maxBufferBytes: 64 * 1024,
        timeoutMs: 30_000,
      });
      if (result.code !== 0) {
        throw new Error(result.stderr.trim() || `git worktree add failed with code ${result.code}`);
      }
    },
    catch: (cause) =>
      new OrchestrationCommandInvariantError({
        commandType: command.type,
        detail: `Unable to allocate isolated workspace '${worktreePath}' for thread '${threadId}': ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });
  const nextCommand =
    command.type === "thread.create"
      ? { ...command, branch, worktreePath }
      : command.type === "thread.turn.start" && command.bootstrap?.createThread
        ? {
            ...command,
            bootstrap: {
              ...command.bootstrap,
              createThread: { ...command.bootstrap.createThread, branch, worktreePath },
            },
          }
        : command.type === "thread.queued-turn.dispatch"
          ? { ...command, workspaceBinding: undefined }
          : command;
  return { command: nextCommand, worktreePath, branch, honoredProjectCheckout: false };
});

export const admitWorkspaceCommand = Effect.fn("admitWorkspace")(function* (
  deps: WorkspaceAdmissionDeps,
  command: OrchestrationCommand,
) {
  let thread: OrchestrationThread | undefined;
  switch (command.type) {
    case "thread.create":
    case "thread.turn.start":
    case "thread.workspace.handoff":
    case "thread.meta.update":
    case "thread.delete":
    case "thread.queued-turn.dispatch":
      thread = deps.findThread((command as { readonly threadId: string }).threadId);
      break;
  }
  const projectId =
    thread?.projectId ??
    (command.type === "thread.create" ? command.projectId : undefined) ??
    (command.type === "thread.turn.start" ? command.bootstrap?.createThread?.projectId : undefined);
  const project = projectId === undefined ? undefined : deps.findProject(projectId);
  const prepared = yield* prepareIsolatedWorkspace(command, project?.workspaceRoot, thread);
  command = prepared.command;
  const requestedPath =
    command.type === "thread.create"
      ? (command.worktreePath ?? project?.workspaceRoot)
      : command.type === "thread.workspace.handoff"
        ? command.worktreePath
        : command.type === "thread.queued-turn.dispatch"
          ? (command.workspaceBinding?.worktreePath ??
            prepared.worktreePath ??
            thread?.workspaceBinding?.worktreePath ??
            thread?.worktreePath ??
            project?.workspaceRoot)
          : command.type === "thread.meta.update"
            ? command.worktreePath
            : ((command.type === "thread.turn.start"
                ? command.bootstrap?.createThread?.worktreePath
                : undefined) ??
              prepared.worktreePath ??
              thread?.workspaceBinding?.worktreePath ??
              thread?.worktreePath ??
              project?.workspaceRoot);
  if (
    requestedPath === undefined ||
    requestedPath === null ||
    !("threadId" in command) ||
    command.type === "thread.delete" ||
    command.type === "thread.archive"
  ) {
    return command;
  }
  const binding = yield* deps
    .claimOwnership({
      threadId: command.threadId,
      worktreePath: requestedPath,
      branch:
        command.type === "thread.create"
          ? command.branch
          : command.type === "thread.workspace.handoff"
            ? command.branch
            : (prepared.branch ?? thread?.workspaceBinding?.branch ?? thread?.branch ?? null),
      commandId: command.commandId,
      now: new Date().toISOString(),
    })
    .pipe(
      Effect.mapError((error) => {
        if (error instanceof WorkspaceOwnershipConflict) {
          return new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Workspace '${error.canonicalPath}' is owned by thread '${error.ownerThreadId}'. Stop that writer or use a different worktree; no edits were stashed or moved.`,
          });
        }
        return new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Workspace admission failed for '${requestedPath}'. Recover the existing owner before retrying.`,
        });
      }),
    );
  const withBinding = {
    ...command,
    workspaceBinding: prepared.honoredProjectCheckout
      ? { ...binding, workspaceScope: "project-checkout" as const }
      : binding,
  } as OrchestrationCommand;
  return withBinding;
});

export const isWorktreeCleanupPending = Effect.fn("isWorktreeCleanupPending")(function* (
  deps: Pick<WorkspaceAdmissionDeps, "hasCleanupReservationByPath">,
  worktreePath: string,
) {
  const canonicalPath = yield* Effect.promise(() => canonicalizeWorktreePath(worktreePath));
  return yield* deps.hasCleanupReservationByPath(canonicalPath);
});
