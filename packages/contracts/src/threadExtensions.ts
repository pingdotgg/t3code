import * as Schema from "effect/Schema";

import {
  ChatAttachment,
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
  SourceProposedPlanReference,
  UploadChatAttachment,
} from "./orchestration.ts";
import { IsoDateTime, MessageId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const FormaInteractionMode = Schema.Literals(["default", "ask", "plan"]);
export type FormaInteractionMode = typeof FormaInteractionMode.Type;

export const ThreadExtensionQueueStatus = Schema.Literals(["idle", "queued", "paused"]);
export type ThreadExtensionQueueStatus = typeof ThreadExtensionQueueStatus.Type;

export const ThreadExtensionQueuePauseReason = Schema.NullOr(
  Schema.Literals(["migration", "interrupted", "provider-error", "start-failed"]),
);
export type ThreadExtensionQueuePauseReason = typeof ThreadExtensionQueuePauseReason.Type;

export const ThreadExtensionQueuedTurn = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  text: Schema.String,
  attachments: Schema.Array(ChatAttachment),
  modelSelection: Schema.optional(ModelSelection),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  askOverride: Schema.Boolean,
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  queuedAt: IsoDateTime,
});
export type ThreadExtensionQueuedTurn = typeof ThreadExtensionQueuedTurn.Type;

export const ThreadExtensionState = Schema.Struct({
  threadId: ThreadId,
  interactionModeOverride: Schema.NullOr(Schema.Literal("ask")),
  queue: Schema.Struct({
    items: Schema.Array(ThreadExtensionQueuedTurn),
    status: ThreadExtensionQueueStatus,
    pauseReason: ThreadExtensionQueuePauseReason,
  }),
  updatedAt: IsoDateTime,
});
export type ThreadExtensionState = typeof ThreadExtensionState.Type;

export const ThreadExtensionGetInput = Schema.Struct({ threadId: ThreadId });
export type ThreadExtensionGetInput = typeof ThreadExtensionGetInput.Type;

export const ThreadExtensionSetInteractionModeInput = Schema.Struct({
  threadId: ThreadId,
  mode: FormaInteractionMode,
});
export type ThreadExtensionSetInteractionModeInput =
  typeof ThreadExtensionSetInteractionModeInput.Type;

export const ThreadExtensionEnqueueTurnInput = Schema.Struct({
  threadId: ThreadId,
  message: Schema.Struct({
    messageId: MessageId,
    text: Schema.String,
    attachments: Schema.Array(UploadChatAttachment),
  }),
  modelSelection: Schema.optional(ModelSelection),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  askOverride: Schema.optional(Schema.Boolean),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  createdAt: IsoDateTime,
});
export type ThreadExtensionEnqueueTurnInput = typeof ThreadExtensionEnqueueTurnInput.Type;

export const ThreadExtensionRemoveQueuedTurnInput = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
});
export type ThreadExtensionRemoveQueuedTurnInput = typeof ThreadExtensionRemoveQueuedTurnInput.Type;

export const ThreadExtensionResumeQueueInput = Schema.Struct({ threadId: ThreadId });
export type ThreadExtensionResumeQueueInput = typeof ThreadExtensionResumeQueueInput.Type;

export const ThreadForkInput = Schema.Struct({
  sourceThreadId: ThreadId,
});
export type ThreadForkInput = typeof ThreadForkInput.Type;

export const ThreadForkResult = Schema.Struct({
  threadId: ThreadId,
});
export type ThreadForkResult = typeof ThreadForkResult.Type;

export class ThreadExtensionError extends Schema.TaggedErrorClass<ThreadExtensionError>()(
  "ThreadExtensionError",
  {
    threadId: Schema.optional(ThreadId),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
