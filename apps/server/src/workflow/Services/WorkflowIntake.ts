import type { AgentSelection, BoardId, WorkflowTicketProposal } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { WorkflowEventStoreError } from "./Errors.ts";

export interface WorkflowIntakeInput {
  readonly boardId: BoardId;
  readonly braindump: string;
  readonly agent: AgentSelection;
}

/**
 * Turns a free-form braindump into proposed tickets by running a one-shot
 * agent turn at the board's project root. Proposals are returned to the
 * client for review — nothing is created server-side.
 */
export interface WorkflowIntakeShape {
  readonly proposeTickets: (
    input: WorkflowIntakeInput,
  ) => Effect.Effect<ReadonlyArray<WorkflowTicketProposal>, WorkflowEventStoreError>;
}

export class WorkflowIntakeService extends Context.Service<
  WorkflowIntakeService,
  WorkflowIntakeShape
>()("t3/workflow/Services/WorkflowIntake/WorkflowIntakeService") {}
