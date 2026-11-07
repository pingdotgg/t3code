import * as Schema from "effect/Schema";

import { ThreadId, TurnItemId } from "./baseSchemas.ts";

/** The user's answer to a delegation card; approving covers only the target the card shows. */
export const DelegationApprovalAnswerInput = Schema.Struct({
  threadId: ThreadId,
  turnItemId: TurnItemId,
  decision: Schema.Literals(["approve", "decline"]),
});
export type DelegationApprovalAnswerInput = typeof DelegationApprovalAnswerInput.Type;

const DELEGATION_APPROVAL_FAILURE_MESSAGES = {
  load_failed: "Could not load the delegation request.",
  not_found: "This delegation request no longer exists.",
  already_answered: "This delegation request was already answered or has ended.",
  agent_stopped: "The agent that asked has stopped, so nothing will start.",
  record_failed: "Could not record the answer. Try again.",
} as const;

export const DelegationApprovalFailureReason = Schema.Literals(
  Object.keys(DELEGATION_APPROVAL_FAILURE_MESSAGES) as Array<
    keyof typeof DELEGATION_APPROVAL_FAILURE_MESSAGES
  >,
);
export type DelegationApprovalFailureReason = typeof DelegationApprovalFailureReason.Type;

export class DelegationApprovalError extends Schema.TaggedError<DelegationApprovalError>()(
  "DelegationApprovalError",
  {
    reason: DelegationApprovalFailureReason,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return DELEGATION_APPROVAL_FAILURE_MESSAGES[this.reason];
  }
}
