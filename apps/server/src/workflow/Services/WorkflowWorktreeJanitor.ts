import type { BoardId, TicketId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/**
 * Everything needed to clean a ticket's git residue after its rows are gone.
 * Plans are collected BEFORE the DB cascade (the repo root and ticket list are
 * only resolvable while the projections still exist) and executed after it.
 */
export interface WorktreeCleanupPlan {
  readonly repoRoot: string;
  readonly ticketIds: ReadonlyArray<TicketId>;
}

export interface WorkflowWorktreeJanitorShape {
  readonly collectBoardPlan: (boardId: BoardId) => Effect.Effect<WorktreeCleanupPlan | null>;
  readonly collectTicketPlan: (ticketId: TicketId) => Effect.Effect<WorktreeCleanupPlan | null>;
  /** Best-effort: removes worktrees, ticket branches, checkpoint refs and lease rows. Never fails. */
  readonly run: (plan: WorktreeCleanupPlan | null) => Effect.Effect<void>;
}

export class WorkflowWorktreeJanitor extends Context.Service<
  WorkflowWorktreeJanitor,
  WorkflowWorktreeJanitorShape
>()("t3/workflow/Services/WorkflowWorktreeJanitor") {}
