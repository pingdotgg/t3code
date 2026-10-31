import type { ThreadId } from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

export class ThreadCommandExecutor extends Context.Service<
  ThreadCommandExecutor,
  KeyedLock.KeyedLock<ThreadId> & {
    /**
     * Serializes fork and deletion planning through commit because forks retain source pages.
     * Take it inside the thread lock; never take a thread lock while holding it.
     */
    readonly withDeletionLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  }
>()("t3/orchestration-v2/ThreadCommandExecutor") {}

export const layer = Layer.effect(
  ThreadCommandExecutor,
  Effect.gen(function* () {
    const threads = yield* KeyedLock.make<ThreadId>();
    const deletion = yield* Semaphore.make(1);
    return { ...threads, withDeletionLock: deletion.withPermit };
  }),
);
