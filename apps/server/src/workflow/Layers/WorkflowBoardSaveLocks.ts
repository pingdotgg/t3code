import type { BoardId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";

import {
  WorkflowBoardSaveLocks,
  type WorkflowBoardSaveLocksShape,
} from "../Services/WorkflowBoardSaveLocks.ts";

export const makeWorkflowBoardSaveLocks = Effect.gen(function* () {
  const saveSemaphores = yield* SynchronizedRef.make<Map<string, Semaphore.Semaphore>>(new Map());

  const semaphoreFor = (boardId: BoardId) =>
    SynchronizedRef.modifyEffect(saveSemaphores, (current) => {
      const key = boardId as string;
      const existing = current.get(key);
      if (existing) {
        return Effect.succeed([existing, current] as const);
      }

      return Semaphore.make(1).pipe(
        Effect.map((semaphore) => {
          const next = new Map(current);
          next.set(key, semaphore);
          return [semaphore, next] as const;
        }),
      );
    });

  const withSaveLock: WorkflowBoardSaveLocksShape["withSaveLock"] = (boardId, effect) =>
    Effect.gen(function* () {
      const semaphore = yield* semaphoreFor(boardId);
      return yield* semaphore.withPermits(1)(effect);
    });

  // Drop a board's cached semaphore so a deleted board doesn't leak its entry.
  // Any in-flight withSaveLock already captured its semaphore reference, so it
  // completes safely; a later withSaveLock for the same id just creates a fresh
  // one (there are no legitimate concurrent saves on a deleted board).
  const evict: NonNullable<WorkflowBoardSaveLocksShape["evict"]> = (boardId) =>
    SynchronizedRef.update(saveSemaphores, (current) => {
      const key = boardId as string;
      if (!current.has(key)) {
        return current;
      }
      const next = new Map(current);
      next.delete(key);
      return next;
    });

  return { withSaveLock, evict } satisfies WorkflowBoardSaveLocksShape;
});

export const WorkflowBoardSaveLocksLive = Layer.effect(
  WorkflowBoardSaveLocks,
  makeWorkflowBoardSaveLocks,
);
