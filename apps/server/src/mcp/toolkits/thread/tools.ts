import {
  ScheduledTaskId,
  ScheduledTask,
  OrchestrationSearchThreadsInput,
  OrchestrationSearchThreadsResult,
  OrchestrationV2ThreadForkSourcePoint,
  OrchestrationV2ContextTransfer,
  TrimmedNonEmptyString,
  ModelSelection,
  RuntimeMode,
  ProviderInteractionMode,
  RuntimeRequestId,
  ProviderUserInputAnswers,
  ProviderApprovalDecision,
  ProviderApprovalOption,
  OrchestrationV2RuntimeRequest,
  IsoDateTime,
  OrchestratorMcpFailure,
  OrchestrationV2DispatchCommandResult,
  ThreadId,
  RunId,
  NonNegativeInt,
  ProjectId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const ThreadOrganizeTool = Tool.make("t3_thread_organize", {
  description:
    "Pin, snooze, settle, archive, mark read or unread, toggle auto-settle, reorder, or permanently delete a thread. Omit threadId for this thread. snooze requires snoozedUntil. move_pinned and move_active reorder the thread within its project's pinned or active list, like dragging in the sidebar; they require beforeThreadId (the thread to land above, or null for the end of the list), and the thread must already be in that list. delete cannot be undone and requires a full-access/default caller. Existing thread lifecycle rules apply; this does not schedule a future action.",
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
      "mark_read",
      "mark_unread",
      "auto_settle_on",
      "auto_settle_off",
      "move_pinned",
      "move_active",
      "delete",
    ]),
    snoozedUntil: Schema.optional(IsoDateTime),
    beforeThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  }),
  success: OrchestrationV2DispatchCommandResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    Crypto.Crypto,
  ],
})
  .annotate(Tool.Title, "Organize a thread")
  .annotate(Tool.Destructive, true);

const queueTarget = { threadId: Schema.optional(ThreadId), queuedRunId: RunId };
const commandTool = {
  success: OrchestrationV2DispatchCommandResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    Crypto.Crypto,
  ],
};
const queueEntry = Schema.Struct({
  queuedRunId: RunId,
  text: Schema.String,
  truncated: Schema.Boolean,
});
const QueueListTool = Tool.make("t3_queue_list", {
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
const QueueReadTool = Tool.make("t3_queue_read", {
  ...commandTool,
  description: "Read up to 16,000 characters of a queued message. Omit threadId for this thread.",
  parameters: Schema.Struct(queueTarget),
  success: queueEntry,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const QueueEditTool = Tool.make("t3_queue_edit", {
  ...commandTool,
  description:
    "Replace a queued message's text, preserving its attachments. The service rejects runs that are no longer queued.",
  parameters: Schema.Struct({
    ...queueTarget,
    text: Schema.String.check(Schema.isMaxLength(100000)),
  }),
}).annotate(Tool.Destructive, true);
const QueueCancelTool = Tool.make("t3_queue_cancel", {
  ...commandTool,
  description: "Cancel a queued run using the existing queue command.",
  parameters: Schema.Struct(queueTarget),
}).annotate(Tool.Destructive, true);
const QueueReorderTool = Tool.make("t3_queue_reorder", {
  ...commandTool,
  description: "Move a queued run before another queued run, or to the end with beforeRunId=null.",
  parameters: Schema.Struct({ ...queueTarget, beforeRunId: Schema.NullOr(RunId) }),
}).annotate(Tool.Destructive, true);
const QueuePromoteTool = Tool.make("t3_queue_promote_to_steer", {
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
const pendingRequestKind = OrchestrationV2RuntimeRequest.fields.kind;
const pendingRequest = Schema.Struct({
  requestId: RuntimeRequestId,
  kind: pendingRequestKind,
  /** Present for user_input requests. */
  questions: Schema.optional(Schema.Array(question)),
  /** Present for approvals when the provider supplied them. */
  prompt: Schema.optional(Schema.String),
  options: Schema.optional(Schema.Array(ProviderApprovalOption)),
});
const PendingRequestListTool = Tool.make("t3_pending_request_list", {
  ...commandTool,
  description:
    "List pending user questions (kind user_input) and approval requests in a thread. Omit threadId for this thread.",
  parameters: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
  success: Schema.Struct({
    requestIds: Schema.Array(RuntimeRequestId),
    requests: Schema.Array(
      Schema.Struct({ requestId: RuntimeRequestId, kind: pendingRequestKind }),
    ),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const PendingRequestReadTool = Tool.make("t3_pending_request_read", {
  ...commandTool,
  description:
    "Read a pending user question or approval request. Respond with t3_pending_request_respond; existing live or message response handling is used.",
  parameters: Schema.Struct(requestTarget),
  success: pendingRequest,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const PendingRequestRespondTool = Tool.make("t3_pending_request_respond", {
  ...commandTool,
  description:
    "Respond to a pending request using the existing runtime response command: answers for a user question, decision for an approval (one of the options from t3_pending_request_read, else cancel, decline, acceptForSession, or accept). Approving requires a full-access/default caller; declining or cancelling does not.",
  parameters: Schema.Struct({
    ...requestTarget,
    answers: Schema.optional(ProviderUserInputAnswers),
    decision: Schema.optional(ProviderApprovalDecision),
  }),
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);
const PendingRequestDismissTool = Tool.make("t3_pending_request_dismiss", {
  ...commandTool,
  description:
    "Dismiss a pending user question without answering it. Only questions answered by message can be dismissed; others need an answer or an interrupt.",
  parameters: Schema.Struct(requestTarget),
}).annotate(Tool.Destructive, true);

const ThreadConfigurationTool = Tool.make("t3_thread_configuration", {
  ...commandTool,
  description:
    "Read a thread's provider/model selection and modes. Omit threadId for this thread. orchestrator_capabilities lists available providers and models.",
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
const ThreadConfigureTool = Tool.make("t3_thread_configure", {
  ...commandTool,
  description:
    "Set a thread's provider, model and options with the existing selection command. Omit threadId for this thread. This does not change permission modes. Use orchestrator_capabilities to choose a selection.",
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    modelSelection: ModelSelection,
  }),
}).annotate(Tool.Destructive, true);

const transferResult = Schema.Struct({ sequence: NonNegativeInt, targetThreadId: ThreadId });
const ThreadForkTool = Tool.make("t3_thread_fork", {
  ...commandTool,
  description:
    "Fork a thread from a stable run or checkpoint using the existing fork command. Omit threadId to fork this thread. The fork inherits the source configuration. Acceptance does not mean a provider turn has completed.",
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    sourcePoint: OrchestrationV2ThreadForkSourcePoint,
    title: Schema.optional(TrimmedNonEmptyString),
  }),
  success: transferResult,
}).annotate(Tool.Destructive, true);
const ThreadMergeBackTool = Tool.make("t3_thread_merge_back", {
  ...commandTool,
  description:
    "Merge context from a thread back to a related thread in the same project. Omit sourceThreadId to merge from this thread. Existing lineage and transfer rules apply.",
  parameters: Schema.Struct({
    sourceThreadId: Schema.optional(ThreadId),
    targetThreadId: ThreadId,
    sourcePoint: OrchestrationV2ThreadForkSourcePoint,
  }),
  success: transferResult,
}).annotate(Tool.Destructive, true);
const ThreadTransfersTool = Tool.make("t3_thread_transfers", {
  ...commandTool,
  description: "Read context transfer status for a thread. Omit threadId for this thread.",
  parameters: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
  success: Schema.Struct({
    transfers: Schema.Array(
      Schema.Struct({
        id: OrchestrationV2ContextTransfer.fields.id,
        sourceThreadId: OrchestrationV2ContextTransfer.fields.sourceThreadId,
        targetThreadId: OrchestrationV2ContextTransfer.fields.targetThreadId,
        status: OrchestrationV2ContextTransfer.fields.status,
      }),
    ),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const ThreadSearchTool = Tool.make("t3_thread_search", {
  ...commandTool,
  description:
    "Search active thread titles and content with the app's existing bounded search. Matches are limited to one project (projectId, else the calling thread's project) out of the global top matches, so this may return fewer than limit. A caller outside a T3 thread that omits projectId searches every project. No pagination or exhaustive-result guarantee.",
  parameters: Schema.Struct({
    ...OrchestrationSearchThreadsInput.fields,
    projectId: Schema.optional(ProjectId),
  }),
  success: OrchestrationSearchThreadsResult,
  dependencies: [...commandTool.dependencies, ThreadSearch.ThreadSearch],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const InboxTool = Tool.make("t3_inbox", {
  ...commandTool,
  description:
    "List active threads that need attention: pending requests first, then failed runs, then unread completed work, newest first. Limited to one project (projectId, else the calling thread's project); a caller outside a T3 thread that omits projectId sees every project. Settled and snoozed threads only appear for pending requests.",
  parameters: Schema.Struct({
    projectId: Schema.optional(ProjectId),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
  }),
  success: Schema.Struct({
    items: Schema.Array(
      Schema.Struct({
        threadId: ThreadId,
        projectId: ProjectId,
        title: Schema.String,
        updatedAt: IsoDateTime,
        reason: Schema.Literals(["pending_request", "error", "unread"]),
        pendingRequest: Schema.optional(
          Schema.Struct({ requestId: RuntimeRequestId, kind: pendingRequestKind }),
        ),
      }),
    ),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const ScheduledTaskRunTool = Tool.make("run_scheduled_task_now", {
  ...commandTool,
  description:
    "Run a scheduled task now through the existing scheduler. Requires a full-access/default caller. Each call is a new manual run; completion means dispatch/bookkeeping completed, not that the provider turn finished.",
  parameters: Schema.Struct({ taskId: ScheduledTaskId }),
  success: Schema.Struct({
    taskId: ScheduledTaskId,
    threadId: ScheduledTask.fields.threadId,
    lastRunStatus: ScheduledTask.fields.lastRunStatus,
    runCount: NonNegativeInt,
    nextRunAt: ScheduledTask.fields.nextRunAt,
  }),
  dependencies: [...commandTool.dependencies, ScheduledTaskService.ScheduledTaskService],
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const ThreadToolkit = Toolkit.make(
  ScheduledTaskRunTool,
  ThreadSearchTool,
  ThreadForkTool,
  ThreadMergeBackTool,
  ThreadTransfersTool,
  ThreadConfigurationTool,
  ThreadConfigureTool,
  PendingRequestListTool,
  PendingRequestReadTool,
  PendingRequestRespondTool,
  PendingRequestDismissTool,
  InboxTool,
  ThreadOrganizeTool,
  QueueListTool,
  QueueReadTool,
  QueueEditTool,
  QueueCancelTool,
  QueueReorderTool,
  QueuePromoteTool,
);
