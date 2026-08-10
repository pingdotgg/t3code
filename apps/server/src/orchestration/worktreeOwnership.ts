import type { OrchestrationReadModel, ThreadId } from "@t3tools/contracts";
import { Effect, Option } from "effect";

import { canonicalizeWorktreePath } from "../git/worktreePaths.ts";

function toExcludedThreadIdSet(
  excludedThreadIds: ThreadId | Iterable<ThreadId>,
): ReadonlySet<ThreadId> {
  if (typeof excludedThreadIds === "string") {
    return new Set([excludedThreadIds]);
  }
  return new Set(excludedThreadIds);
}

export const findCanonicalActiveWorktreeOwner = Effect.fn("findCanonicalActiveWorktreeOwner")(
  function* (
    readModel: OrchestrationReadModel,
    excludedThreadIds: ThreadId | Iterable<ThreadId>,
    worktreePath: string,
  ) {
    const excluded = toExcludedThreadIdSet(excludedThreadIds);
    const canonicalWorktreePath = yield* Effect.promise(() =>
      canonicalizeWorktreePath(worktreePath),
    );
    const activeThreads = readModel.threads.flatMap((thread) => {
      if (
        excluded.has(thread.id) ||
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
