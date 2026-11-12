import { CommandId } from "@t3tools/contracts";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
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

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
    const reconcile = yield* make;
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
