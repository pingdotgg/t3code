import type { ThreadId } from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

export class ThreadCommandExecutor extends Context.Service<
  ThreadCommandExecutor,
  KeyedLock.KeyedLock<ThreadId> & {
    readonly withDeletionLock: Semaphore.Semaphore["withPermit"];
  }
>()("t3/orchestration-v2/ThreadCommandExecutor") {}

export const layer = Layer.effect(
  ThreadCommandExecutor,
  Effect.gen(function* () {
    const threads = yield* KeyedLock.make<ThreadId>();
    const deletions = yield* Semaphore.make(1);
    return ThreadCommandExecutor.of({
      ...threads,
      withDeletionLock: deletions.withPermit,
    });
  }),
);
