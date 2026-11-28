import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * Threads whose settle script is queued or running. Settlement closes a thread's terminals before
 * its script gets the server-wide slot, so storage cleanup keeps these worktrees until it does.
 */
export class PendingSettleScripts extends Context.Service<
  PendingSettleScripts,
  {
    readonly has: (threadId: ThreadId) => boolean;
    readonly track: (
      threadId: ThreadId,
    ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  }
>()("t3/orchestration-v2/PendingSettleScripts") {}

export const layer = Layer.sync(PendingSettleScripts, () => {
  const counts = new Map<ThreadId, number>();
  return {
    has: (threadId) => counts.has(threadId),
    track: (threadId) => (effect) =>
      Effect.acquireUseRelease(
        Effect.sync(() => counts.set(threadId, (counts.get(threadId) ?? 0) + 1)),
        () => effect,
        () =>
          Effect.sync(() => {
            const count = (counts.get(threadId) ?? 1) - 1;
            if (count === 0) counts.delete(threadId);
            else counts.set(threadId, count);
          }),
      ),
  };
});
