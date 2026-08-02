import type { OrchestrationReadModel, ThreadId } from "@t3tools/contracts";
import { Effect, Option } from "effect";

import { canonicalizeWorktreePath } from "../git/worktreePaths.ts";

export const findCanonicalActiveWorktreeOwner = Effect.fn("findCanonicalActiveWorktreeOwner")(
  function* (readModel: OrchestrationReadModel, excludedThreadId: ThreadId, worktreePath: string) {
    const canonicalWorktreePath = yield* Effect.promise(() =>
      canonicalizeWorktreePath(worktreePath),
    );
    const activeThreads = readModel.threads.flatMap((thread) => {
      if (
        thread.id === excludedThreadId ||
        thread.deletedAt !== null ||
        thread.archivedAt !== null ||
        thread.worktreePath === null
      ) {
        return [];
      }
      return [{ id: thread.id, worktreePath: thread.worktreePath }];
    });
    const matches = yield* Effect.forEach(
      activeThreads,
      (thread) =>
        Effect.promise(() => canonicalizeWorktreePath(thread.worktreePath!)).pipe(
          Effect.map((canonicalActivePath) => canonicalActivePath === canonicalWorktreePath),
        ),
      { concurrency: 4 },
    );
    const owner = activeThreads[matches.findIndex(Boolean)];
    return owner === undefined ? Option.none<ThreadId>() : Option.some(owner.id);
  },
);
