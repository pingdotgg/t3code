import type { TicketDiff, TicketId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { WorkflowEventStoreError } from "./Errors.ts";

export interface WorktreeDiffPortShape {
  readonly diffRefToWorktree: (input: {
    readonly cwd: string;
    readonly baseRef: string;
  }) => Effect.Effect<
    { readonly patch: string; readonly truncated: boolean },
    WorkflowEventStoreError
  >;
}

export class WorktreeDiffPort extends Context.Service<WorktreeDiffPort, WorktreeDiffPortShape>()(
  "t3/workflow/Services/TicketDiffQuery/WorktreeDiffPort",
) {}

export interface TicketDiffQueryShape {
  readonly getTicketDiff: (
    ticketId: TicketId,
    cwd: string,
    baseRef: string,
  ) => Effect.Effect<TicketDiff, WorkflowEventStoreError>;
}

export class TicketDiffQuery extends Context.Service<TicketDiffQuery, TicketDiffQueryShape>()(
  "t3/workflow/Services/TicketDiffQuery",
) {}
