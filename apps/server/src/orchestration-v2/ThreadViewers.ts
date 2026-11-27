import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

export class ThreadViewers extends Context.Service<
  ThreadViewers,
  {
    /** Counts a client viewing `threadId` until the enclosing scope closes. */
    readonly view: (threadId: string) => Effect.Effect<void, never, Scope.Scope>;
    readonly isViewed: (threadId: string) => boolean;
  }
>()("t3/orchestration-v2/ThreadViewers") {}

export const layer = Layer.sync(ThreadViewers, () => {
  const viewers = new Map<string, number>();
  return ThreadViewers.of({
    view: Effect.fn("ThreadViewers.view")(function* (threadId: string) {
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          viewers.set(threadId, (viewers.get(threadId) ?? 0) + 1);
        }),
        () =>
          Effect.sync(() => {
            const remaining = (viewers.get(threadId) ?? 1) - 1;
            if (remaining > 0) viewers.set(threadId, remaining);
            else viewers.delete(threadId);
          }),
      );
    }),
    isViewed: (threadId) => viewers.has(threadId),
  });
});
