import type { PullRequestStep, StepOutcome, StepRunId, TicketId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { WorkflowEventStoreError } from "./Errors.ts";

export interface TicketPullRequestInput {
  readonly ticketId: TicketId;
  readonly stepRunId: StepRunId;
  readonly repoRoot: string;
  readonly worktreePath: string;
  readonly worktreeRef: string; // the per-ticket branch name, e.g. "workflow/<ticketId>"
  readonly step: PullRequestStep;
}

export interface TicketPullRequestServiceShape {
  readonly open: (
    input: TicketPullRequestInput,
  ) => Effect.Effect<StepOutcome, WorkflowEventStoreError>;
  readonly land: (
    input: TicketPullRequestInput,
  ) => Effect.Effect<StepOutcome, WorkflowEventStoreError>;
}

export class TicketPullRequestService extends Context.Service<
  TicketPullRequestService,
  TicketPullRequestServiceShape
>()("t3/workflow/Services/TicketPullRequestService") {}
