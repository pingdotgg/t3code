import type { StepRunId, TicketId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { WorkflowEventStoreError } from "./Errors.ts";

export interface TicketCheckpointServiceShape {
  readonly captureBaseline: (
    ticketId: TicketId,
    cwd: string,
  ) => Effect.Effect<string, WorkflowEventStoreError>;
  readonly hasBaseline: (
    ticketId: TicketId,
    cwd: string,
  ) => Effect.Effect<boolean, WorkflowEventStoreError>;
  readonly captureStep: (
    ticketId: TicketId,
    stepRunId: StepRunId,
    cwd: string,
    kind: "pre" | "post",
  ) => Effect.Effect<string, WorkflowEventStoreError>;
}

export class TicketCheckpointService extends Context.Service<
  TicketCheckpointService,
  TicketCheckpointServiceShape
>()("t3/workflow/Services/TicketCheckpointService") {}
