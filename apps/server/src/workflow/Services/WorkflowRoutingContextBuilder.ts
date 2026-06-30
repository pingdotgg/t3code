import type { PipelineRunId, TicketId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { WorkflowEventStoreError } from "./Errors.ts";

export type RoutingPipelineResult = "success" | "failure" | "blocked";

export interface WorkflowRoutingStepContext {
  readonly exitCode: number | null;
  readonly status: string;
  readonly output: unknown | null;
}

export interface WorkflowRoutingContext {
  readonly pipeline: {
    readonly result: RoutingPipelineResult;
  };
  readonly lane: {
    // How many pipeline runs (including this one) this ticket has had in the
    // current lane — lets transitions bound loops, e.g. re-enter the lane
    // while runCount < 3 and escalate to a manual lane afterwards.
    readonly runCount: number;
  };
  readonly status: string;
  readonly steps: Readonly<Record<string, WorkflowRoutingStepContext>>;
}

export interface WorkflowRoutingContextBuilderShape {
  readonly build: (input: {
    readonly ticketId: TicketId;
    readonly pipelineRunId: PipelineRunId;
    readonly result: RoutingPipelineResult;
  }) => Effect.Effect<WorkflowRoutingContext, WorkflowEventStoreError>;
}

export class WorkflowRoutingContextBuilder extends Context.Service<
  WorkflowRoutingContextBuilder,
  WorkflowRoutingContextBuilderShape
>()("t3/workflow/Services/WorkflowRoutingContextBuilder") {}
