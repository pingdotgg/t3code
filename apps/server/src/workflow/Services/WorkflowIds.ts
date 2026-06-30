import type {
  LaneEntryToken,
  MessageId,
  PipelineRunId,
  ScriptRunId,
  StepRunId,
  TicketId,
  WorkflowEventId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface WorkflowIdsShape {
  readonly ticketId: () => Effect.Effect<TicketId>;
  readonly pipelineRunId: () => Effect.Effect<PipelineRunId>;
  readonly scriptRunId: () => Effect.Effect<ScriptRunId>;
  readonly stepRunId: () => Effect.Effect<StepRunId>;
  readonly messageId: () => Effect.Effect<MessageId>;
  readonly eventId: () => Effect.Effect<WorkflowEventId>;
  readonly token: () => Effect.Effect<LaneEntryToken>;
  // Opaque unique id for a work_source_mapping row (Task 9 committer). Not a
  // branded contract type — the mapping_id column is a plain TEXT primary key.
  readonly mappingId: () => Effect.Effect<string>;
}

export class WorkflowIds extends Context.Service<WorkflowIds, WorkflowIdsShape>()(
  "t3/workflow/Services/WorkflowIds",
) {}
