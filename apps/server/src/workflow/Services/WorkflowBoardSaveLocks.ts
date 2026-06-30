import type { BoardId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface WorkflowBoardSaveLocksShape {
  readonly withSaveLock: <A, E, R>(
    boardId: BoardId,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  /**
   * Drop the cached per-board save semaphore so a deleted board does not leak its
   * lock entry for the process lifetime. Call AFTER a board's owned state is
   * deleted (no legitimate concurrent save can target a deleted board). Optional
   * so lightweight mocks need not implement it; callers must no-op when absent.
   */
  readonly evict?: (boardId: BoardId) => Effect.Effect<void>;
}

export class WorkflowBoardSaveLocks extends Context.Service<
  WorkflowBoardSaveLocks,
  WorkflowBoardSaveLocksShape
>()("t3/workflow/Services/WorkflowBoardSaveLocks") {}
