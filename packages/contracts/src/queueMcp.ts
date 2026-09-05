import * as Schema from "effect/Schema";

import {
  CommandId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  ChatAttachment,
  ChatAttachmentId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
} from "./chatAttachment.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const QueueMcpClientRequestId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const QueueMcpCursor = NonNegativeInt;
const QueueMcpLimit = PositiveInt.check(Schema.isLessThanOrEqualTo(100));
const QueueMcpMaxChars = PositiveInt.check(Schema.isLessThanOrEqualTo(120_000));
const QueueMcpListMaxChars = PositiveInt.check(Schema.isLessThanOrEqualTo(8_000));

const QueueMcpThreadTarget = {
  threadId: Schema.optional(
    ThreadId.annotate({
      description: "Thread in the calling thread's project. Omit to target the calling thread.",
    }),
  ),
};

export const QueueMcpListInput = Schema.Struct({
  ...QueueMcpThreadTarget,
  cursor: Schema.optional(QueueMcpCursor),
  limit: Schema.optional(QueueMcpLimit),
  maxCharsPerMessage: Schema.optional(QueueMcpListMaxChars),
});
export type QueueMcpListInput = typeof QueueMcpListInput.Type;

export const QueueMcpReadInput = Schema.Struct({
  ...QueueMcpThreadTarget,
  queuedRunId: RunId,
  maxChars: Schema.optional(QueueMcpMaxChars),
});
export type QueueMcpReadInput = typeof QueueMcpReadInput.Type;

export const QueueMcpEditInput = Schema.Struct({
  ...QueueMcpThreadTarget,
  queuedRunId: RunId,
  text: Schema.String.check(
    Schema.makeFilter((text) => text.trim().length > 0 || "Queued text must not be blank."),
    Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS),
  ),
  attachmentIds: Schema.optional(
    Schema.Array(ChatAttachmentId).check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)),
  ).annotate({
    description:
      "Full replacement using attachment IDs already owned by this thread. Omit to preserve attachments; [] clears them.",
  }),
  clientRequestId: Schema.optional(QueueMcpClientRequestId),
});
export type QueueMcpEditInput = typeof QueueMcpEditInput.Type;

export const QueueMcpReorderInput = Schema.Struct({
  ...QueueMcpThreadTarget,
  queuedRunId: RunId,
  beforeRunId: Schema.NullOr(RunId).annotate({
    description: "Queued run to move before, or null to move to the end of the user queue.",
  }),
  clientRequestId: Schema.optional(QueueMcpClientRequestId),
});
export type QueueMcpReorderInput = typeof QueueMcpReorderInput.Type;

export const QueueMcpCancelInput = Schema.Struct({
  ...QueueMcpThreadTarget,
  queuedRunId: RunId,
  clientRequestId: Schema.optional(QueueMcpClientRequestId),
});
export type QueueMcpCancelInput = typeof QueueMcpCancelInput.Type;

export const QueueMcpPromoteInput = Schema.Struct({
  ...QueueMcpThreadTarget,
  queuedRunId: RunId,
  targetRunId: RunId,
  clientRequestId: Schema.optional(QueueMcpClientRequestId),
});
export type QueueMcpPromoteInput = typeof QueueMcpPromoteInput.Type;

export const QueueMcpQueuedRun = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  queuedRunId: RunId,
  messageId: MessageId,
  queuePosition: PositiveInt,
  ordinal: PositiveInt,
  providerInstanceId: ProviderInstanceId,
  model: Schema.String,
  requestedAt: IsoDateTime,
  text: Schema.String,
  textTruncated: Schema.Boolean,
  attachments: Schema.Array(ChatAttachment),
  automaticCompletion: Schema.Boolean,
});
export type QueueMcpQueuedRun = typeof QueueMcpQueuedRun.Type;

export const QueueMcpListResult = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  runs: Schema.Array(QueueMcpQueuedRun),
  nextCursor: Schema.NullOr(NonNegativeInt),
  total: NonNegativeInt,
});
export type QueueMcpListResult = typeof QueueMcpListResult.Type;

export const QueueMcpReadResult = QueueMcpQueuedRun;
export type QueueMcpReadResult = typeof QueueMcpReadResult.Type;

const QueueMcpReceipt = {
  commandId: CommandId,
  receiptSequence: NonNegativeInt,
};

export const QueueMcpEditResult = Schema.Struct({
  ...QueueMcpReceipt,
  threadId: ThreadId,
  queuedRunId: RunId,
  messageId: MessageId,
  text: Schema.String,
  attachments: Schema.Array(ChatAttachment),
});
export type QueueMcpEditResult = typeof QueueMcpEditResult.Type;

export const QueueMcpReorderResult = Schema.Struct({
  ...QueueMcpReceipt,
  threadId: ThreadId,
  queuedRunId: RunId,
  beforeRunId: Schema.NullOr(RunId).annotate({
    description:
      "Destination requested by this call; inspect outcome before treating it as applied.",
  }),
  outcome: Schema.Literals(["applied", "receipt_replayed"]),
});
export type QueueMcpReorderResult = typeof QueueMcpReorderResult.Type;

export const QueueMcpCancelResult = Schema.Struct({
  ...QueueMcpReceipt,
  threadId: ThreadId,
  queuedRunId: RunId,
  status: Schema.Literal("cancelled"),
});
export type QueueMcpCancelResult = typeof QueueMcpCancelResult.Type;

export const QueueMcpPromoteResult = Schema.Struct({
  ...QueueMcpReceipt,
  threadId: ThreadId,
  queuedRunId: RunId,
  targetRunId: RunId,
  status: Schema.Literal("promoted"),
});
export type QueueMcpPromoteResult = typeof QueueMcpPromoteResult.Type;

export class QueueMcpFailure extends Schema.TaggedErrorClass<QueueMcpFailure>()("QueueMcpFailure", {
  code: Schema.Literals([
    "capability_denied",
    "thread_not_found",
    "queued_run_not_found",
    "attachment_not_found",
    "invalid_request",
    "runtime_mode_escalation_denied",
    "interaction_mode_escalation_denied",
    "operation_rejected",
    "orchestration_error",
  ]),
  message: Schema.String,
}) {}
