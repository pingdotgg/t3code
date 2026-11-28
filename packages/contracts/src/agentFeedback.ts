import * as Schema from "effect/Schema";

import { ThreadId, TurnItemId } from "./baseSchemas.ts";

export const AgentFeedbackKind = Schema.Literals([
  "bug",
  "confusing",
  "missing_capability",
  "wrong_docs",
  "other",
]);

/** Built by the server from the thread's stored items; the agent never writes it. */
export const AgentFeedbackTrace = Schema.Struct({
  turns: Schema.Int,
  textTurns: Schema.Int,
  /** A cap dropped an entry or cut or dropped a message text. */
  truncated: Schema.Boolean,
  entries: Schema.Array(
    Schema.Struct({
      turn: Schema.Int,
      type: Schema.Literals(["user", "assistant", "tool"]),
      tool: Schema.optionalKey(Schema.String),
      outcome: Schema.optionalKey(Schema.Literals(["ok", "error", "unfinished"])),
      durationMs: Schema.optionalKey(Schema.Int),
      /** A message's length in characters. */
      length: Schema.optionalKey(Schema.Int),
      text: Schema.optionalKey(Schema.String),
    }),
  ),
});
export type AgentFeedbackTrace = typeof AgentFeedbackTrace.Type;

/** Exactly what a requested report sends once the user approves it, already scrubbed. */
export const AgentFeedbackPreview = Schema.Struct({
  kind: AgentFeedbackKind,
  subject: Schema.String,
  expected: Schema.String,
  actual: Schema.String,
  workaround: Schema.String,
  trace: Schema.NullOr(AgentFeedbackTrace),
});
export type AgentFeedbackPreview = typeof AgentFeedbackPreview.Type;

export const AgentFeedbackRequestStatus = Schema.Literals([
  "pending",
  "sent",
  "declined",
  "cancelled",
]);
export type AgentFeedbackRequestStatus = typeof AgentFeedbackRequestStatus.Type;

export const AgentFeedbackAnswerInput = Schema.Struct({
  threadId: ThreadId,
  turnItemId: TurnItemId,
  answer: Schema.Literals(["send", "decline"]),
  /** Send the card's conversation trace instead of its outline. */
  includeConversation: Schema.optionalKey(Schema.Boolean),
});
export type AgentFeedbackAnswerInput = typeof AgentFeedbackAnswerInput.Type;

const AGENT_FEEDBACK_REQUEST_FAILURE_MESSAGES = {
  load_failed: "Could not load the feedback report.",
  not_found: "This feedback report no longer exists.",
  already_answered: "This feedback report was already answered.",
  feedback_off: "Agent feedback is off, so this report was not sent.",
  record_failed: "Could not record your answer.",
} as const;

export class AgentFeedbackRequestError extends Schema.TaggedError<AgentFeedbackRequestError>()(
  "AgentFeedbackRequestError",
  {
    reason: Schema.Literals(
      Object.keys(AGENT_FEEDBACK_REQUEST_FAILURE_MESSAGES) as Array<
        keyof typeof AGENT_FEEDBACK_REQUEST_FAILURE_MESSAGES
      >,
    ),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return AGENT_FEEDBACK_REQUEST_FAILURE_MESSAGES[this.reason];
  }
}
