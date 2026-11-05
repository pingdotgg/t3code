import { CommandId } from "@t3tools/contracts";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import { forkParked } from "../serverActivation.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const git = yield* GitWorkflowService.GitWorkflowService;
  return Effect.fn("WorktreeBranchSync.reconcile")(function* (input: {
    readonly cwd: string;
    readonly refName: string | null;
  }) {
    if (input.refName === null) return;
    const snapshot = yield* threads.getShellSnapshot({ worktreePath: input.cwd });
    const sharing = [...snapshot.threads, ...snapshot.archivedThreads].filter(
      (thread) => thread.worktreePath === input.cwd && thread.branch !== input.refName,
    );
    if (sharing.length === 0) return;
    // Status events may queue behind a generated rename or another checkout.
    if ((yield* git.currentBranch(input.cwd)) !== input.refName) return;
    for (const thread of sharing) {
      yield* threads.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(yield* randomUuidV4),
        threadId: thread.id,
        branch: input.refName,
        expectedBranch: thread.branch,
        expectedWorktreePath: thread.worktreePath,
      });
    }
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
    const reconcile = yield* make;
    yield* forkParked(
      Stream.runForEach(broadcaster.streamLocalChanges, ({ cwd, local }) =>
        Effect.gen(function* () {
          if (!local.isRepo) return;
          yield* reconcile({ cwd, refName: local.refName });
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Failed to reconcile worktree branch", { cwd, cause }),
          ),
        ),
      ),
    );
  }),
);
