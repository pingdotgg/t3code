import {
  ModelSelection,
  RuntimeMode,
  ProviderInteractionMode,
  RuntimeRequestId,
  ProviderUserInputAnswers,
  IsoDateTime,
  OrchestratorMcpFailure,
  OrchestrationV2DispatchCommandResult,
  ThreadId,
  RunId,
  NonNegativeInt,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";

export const ThreadOrganizeTool = Tool.make("t3_thread_organize", {
  description:
    "Pin, snooze, settle, archive, or mark a thread unread in the calling project. Omit threadId for this thread. snooze requires snoozedUntil. Existing thread lifecycle rules apply; this does not schedule a future action.",
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    action: Schema.Literals([
      "pin",
      "unpin",
      "snooze",
      "unsnooze",
      "settle",
      "unsettle",
      "archive",
      "unarchive",
      "mark_unread",
    ]),
    snoozedUntil: Schema.optional(IsoDateTime),
  }),
  success: OrchestrationV2DispatchCommandResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [McpInvocationContext, ThreadManagementService, Crypto.Crypto],
})
  .annotate(Tool.Title, "Organize a thread")
  .annotate(Tool.Destructive, true);

const queueTarget = { threadId: Schema.optional(ThreadId), queuedRunId: RunId };
const commandTool = {
  success: OrchestrationV2DispatchCommandResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [McpInvocationContext, ThreadManagementService, Crypto.Crypto],
};
const queueEntry = Schema.Struct({
  queuedRunId: RunId,
  text: Schema.String,
  truncated: Schema.Boolean,
});
export const QueueListTool = Tool.make("t3_queue_list", {
  ...commandTool,
  description:
    "List queued messages in delivery order. Results are a live offset page; use t3_thread_read for full thread history.",
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    cursor: Schema.optional(NonNegativeInt),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  }),
  success: Schema.Struct({
    items: Schema.Array(queueEntry),
    nextCursor: Schema.NullOr(NonNegativeInt),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
export const QueueReadTool = Tool.make("t3_queue_read", {
  ...commandTool,
  description: "Read up to 16,000 characters of a queued message in the calling project.",
  parameters: Schema.Struct(queueTarget),
  success: queueEntry,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
export const QueueEditTool = Tool.make("t3_queue_edit", {
  ...commandTool,
  description:
    "Replace a queued message's text, preserving its attachments. The service rejects runs that are no longer queued.",
  parameters: Schema.Struct({
    ...queueTarget,
    text: Schema.String.check(Schema.isMaxLength(100000)),
  }),
}).annotate(Tool.Destructive, true);
export const QueueCancelTool = Tool.make("t3_queue_cancel", {
  ...commandTool,
  description: "Cancel a queued run using the existing queue command.",
  parameters: Schema.Struct(queueTarget),
}).annotate(Tool.Destructive, true);
export const QueueReorderTool = Tool.make("t3_queue_reorder", {
  ...commandTool,
  description: "Move a queued run before another queued run, or to the end with beforeRunId=null.",
  parameters: Schema.Struct({ ...queueTarget, beforeRunId: Schema.NullOr(RunId) }),
}).annotate(Tool.Destructive, true);
export const QueuePromoteTool = Tool.make("t3_queue_promote_to_steer", {
  ...commandTool,
  description:
    "Deliver a queued message as steering to the specified active run. Existing provider and run-state rules apply.",
  parameters: Schema.Struct({ ...queueTarget, targetRunId: RunId }),
}).annotate(Tool.Destructive, true);

const requestTarget = { threadId: Schema.optional(ThreadId), requestId: RuntimeRequestId };
const question = Schema.Struct({
  id: Schema.String,
  header: Schema.String,
  question: Schema.String,
  options: Schema.Array(
    Schema.Struct({
      label: Schema.String,
      description: Schema.String,
      value: Schema.optional(Schema.String),
    }),
  ),
  multiSelect: Schema.optional(Schema.Boolean),
  allowCustomAnswer: Schema.optional(Schema.Boolean),
  required: Schema.optional(Schema.Boolean),
});
const pendingRequest = Schema.Struct({
  requestId: RuntimeRequestId,
  questions: Schema.Array(question),
});
export const PendingRequestListTool = Tool.make("t3_pending_request_list", {
  ...commandTool,
  description:
    "List pending user questions in a thread in the calling project. Approval requests are not included.",
  parameters: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
  success: Schema.Struct({ requestIds: Schema.Array(RuntimeRequestId) }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
export const PendingRequestReadTool = Tool.make("t3_pending_request_read", {
  ...commandTool,
  description:
    "Read a pending user question. Answer with t3_pending_request_respond; existing live or message response handling is used.",
  parameters: Schema.Struct(requestTarget),
  success: pendingRequest,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
export const PendingRequestRespondTool = Tool.make("t3_pending_request_respond", {
  ...commandTool,
  description:
    "Answer a pending user-input request using the existing runtime response command. This cannot approve a permission request.",
  parameters: Schema.Struct({ ...requestTarget, answers: ProviderUserInputAnswers }),
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const ThreadConfigurationTool = Tool.make("t3_thread_configuration", {
  ...commandTool,
  description:
    "Read a thread's provider/model selection and modes in the calling project. orchestrator_capabilities lists available providers and models.",
  parameters: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
  success: Schema.Struct({
    threadId: ThreadId,
    modelSelection: ModelSelection,
    runtimeMode: RuntimeMode,
    interactionMode: ProviderInteractionMode,
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
export const ThreadConfigureTool = Tool.make("t3_thread_configure", {
  ...commandTool,
  description:
    "Set this calling thread's provider, model and options with the existing selection command. This does not change permission modes or other threads. Use orchestrator_capabilities to choose a selection.",
  parameters: Schema.Struct({ modelSelection: ModelSelection }),
}).annotate(Tool.Destructive, true);

export const ThreadToolkit = Toolkit.make(
  ThreadConfigurationTool,
  ThreadConfigureTool,
  PendingRequestListTool,
  PendingRequestReadTool,
  PendingRequestRespondTool,
  ThreadOrganizeTool,
  QueueListTool,
  QueueReadTool,
  QueueEditTool,
  QueueCancelTool,
  QueueReorderTool,
  QueuePromoteTool,
);
