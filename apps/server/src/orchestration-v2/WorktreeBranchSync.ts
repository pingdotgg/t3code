import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import { forkParked } from "../serverActivation.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as WorktreeBranches from "./WorktreeBranches.ts";

const makeReconcile = Effect.gen(function* () {
  const worktrees = yield* WorktreeBranches.WorktreeBranches;
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
    if (matchingPaths.size === 0) return;
    // Status events may queue behind a generated rename or another checkout.
    if ((yield* git.currentBranch(input.cwd)) !== input.refName) return;
    yield* worktrees.sync({ worktreePath: input.cwd, threadPaths: [...matchingPaths] });
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
    const reconcile = yield* makeReconcile;
    // Each update waits on its thread's lock, so a busy thread delays only its own worktree.
    const worktrees = yield* KeyedLock.makeRunner<string>();
    yield* forkParked(
      Stream.runForEach(broadcaster.streamBranchChanges, (input) =>
        worktrees.run(
          input.cwd,
          reconcile(input).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to reconcile worktree branch", { cwd: input.cwd, cause }),
            ),
          ),
        ),
      ),
    );
  }),
);
