import { CommandId, type OrchestrationV2DomainEvent, type ThreadId } from "@t3tools/contracts";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { forkParked } from "../serverActivation.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const git = yield* GitWorkflowService.GitWorkflowService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const fs = yield* FileSystem.FileSystem;
  return Effect.fn("WorktreeBranchSync.reconcile")(function* (input: {
    readonly cwd: string;
    readonly refName: string | null;
  }) {
    if (input.refName === null) return;
    const paths = yield* projections.getThreadWorktreePaths({ includeArchived: true });
    const matchingPaths = new Set<string>();
    for (const worktreePath of new Set(paths.map((thread) => thread.worktreePath))) {
      const realPath =
        worktreePath === input.cwd
          ? worktreePath
          : yield* fs.realPath(worktreePath).pipe(Effect.orElseSucceed(() => null));
      if (realPath === input.cwd) matchingPaths.add(worktreePath);
    }
    const matchingThreads = new Map(
      paths
        .filter((thread) => matchingPaths.has(thread.worktreePath))
        .map((thread) => [thread.threadId, thread.worktreePath]),
    );
    if (matchingThreads.size === 0) return;
    const snapshot = yield* threads.getShellSnapshot({ threadIds: [...matchingThreads.keys()] });
    const sharing = [...snapshot.threads, ...snapshot.archivedThreads].filter(
      (thread) =>
        thread.worktreePath === matchingThreads.get(thread.id) && thread.branch !== input.refName,
    );
    if (sharing.length === 0) return;
    // Status events may queue behind a generated rename or another checkout.
    if ((yield* git.currentBranch(input.cwd)) !== input.refName) return;
    for (const thread of sharing) {
      yield* threads
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(yield* randomUuidV4),
          threadId: thread.id,
          branch: input.refName,
          expectedBranch: thread.branch,
          expectedWorktreePath: thread.worktreePath,
        })
        .pipe(
          Effect.catchTags({
            OrchestratorDispatchError: (cause) =>
              Effect.logWarning("Worktree branch update was rejected", {
                threadId: thread.id,
                cause,
              }),
          }),
        );
    }
  });
});

// A provider that moved itself (Claude's EnterWorktree/ExitWorktree) reports where it went on
// its session. Adopting that location detaches the session, so wait until the thread is idle.
const makeFollowSessionMove = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const git = yield* GitWorkflowService.GitWorkflowService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectService.ProjectService;
  const fs = yield* FileSystem.FileSystem;
  return Effect.fn("WorktreeBranchSync.followSessionMove")(function* (threadId: ThreadId) {
    const thread = yield* projections.getThreadShell(threadId);
    if (thread === null || thread.deletedAt !== null || thread.activeRunId !== null) return;
    const { providerSessions } = yield* projections.getThreadProviderContext(threadId);
    const moved = providerSessions.filter(
      (session) =>
        session.cwdChangeSource !== undefined &&
        session.status !== "stopped" &&
        session.status !== "error" &&
        !session.capabilities.sessions.supportsMultipleProviderThreadsPerSession,
    );
    const session = moved.length === 1 ? moved[0] : undefined;
    if (session === undefined) return;
    const project = yield* projects.getById(thread.projectId);
    if (Option.isNone(project)) return;
    const { workspaceRoot } = project.value;
    // A move observed from another checkout is stale once the thread was re-pointed.
    if (session.cwdChangeSource !== (thread.worktreePath ?? workspaceRoot)) return;
    const resolve = (path: string) => fs.realPath(path).pipe(Effect.orElseSucceed(() => path));
    const location = yield* resolve(session.cwd);
    if (location === (yield* resolve(session.cwdChangeSource))) return;
    const worktreePath = location === (yield* resolve(workspaceRoot)) ? null : session.cwd;
    yield* threads
      .dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(yield* randomUuidV4),
        threadId,
        worktreePath,
        branch: yield* git.currentBranch(location),
        expectedBranch: thread.branch,
        expectedWorktreePath: thread.worktreePath,
        // The reads above race a follow-up turn, which this update's detach would end.
        expectedIdle: true,
      })
      .pipe(
        Effect.catchTags({
          OrchestratorDispatchError: (cause) =>
            Effect.logWarning("Worktree move update was rejected", { threadId, cause }),
        }),
      );
  });
});

const isSessionMoveTrigger = (event: OrchestrationV2DomainEvent) =>
  (event.type === "provider-session.updated" && event.payload.cwdChangeSource !== undefined) ||
  (event.type === "run.updated" &&
    ["completed", "interrupted", "failed", "cancelled"].includes(event.payload.status));

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const reconcile = yield* make;
    const followSessionMove = yield* makeFollowSessionMove;
    yield* forkParked(
      Stream.runForEach(threads.streamDomainEvents, (event) =>
        isSessionMoveTrigger(event)
          ? followSessionMove(event.threadId).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Failed to follow a provider worktree move", {
                  threadId: event.threadId,
                  cause,
                }),
              ),
            )
          : Effect.void,
      ),
    );
    yield* forkParked(
      Stream.runForEach(broadcaster.streamBranchChanges, (input) =>
        reconcile(input).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Failed to reconcile worktree branch", { cwd: input.cwd, cause }),
          ),
        ),
      ),
    );
  }),
);
