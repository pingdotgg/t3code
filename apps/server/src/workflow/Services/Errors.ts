import * as Schema from "effect/Schema";

/**
 * Stable, machine-checkable classification codes for WorkflowEventStoreError so
 * consumers can branch on a TERMINAL vs RETRYABLE condition without coupling to
 * a human-readable message string. Add new codes here rather than matching text.
 */
export const WorkflowEventStoreErrorCode = {
  /** External event targeted a ticket that is not on the given board (terminal). */
  ticketNotOnBoard: "ticket_not_on_board",
} as const;

export class WorkflowEventStoreError extends Schema.TaggedErrorClass<WorkflowEventStoreError>()(
  "WorkflowEventStoreError",
  {
    message: Schema.String,
    code: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {}
