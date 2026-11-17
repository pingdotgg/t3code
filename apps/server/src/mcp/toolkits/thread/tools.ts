import {
  OrchestratorMcpEnvironmentTarget,
  ScheduledTaskId,
  ScheduledTask,
  OrchestrationSearchThreadsInput,
  OrchestrationSearchThreadsResult,
  OrchestrationThreadSearchMatch,
  OrchestrationV2ThreadForkSourcePoint,
  OrchestrationV2ThreadGroup,
  OrchestrationV2ContextTransfer,
  TrimmedNonEmptyString,
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
  ProjectId,
  clampedPositiveInt,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as ToolSearch from "../../../orchestration-v2/ToolSearch.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as ThreadGroupService from "../../../orchestration-v2/ThreadGroupService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const ThreadOrganizeTool = Tool.make("t3_thread_organize", {
  description:
    "Pin, snooze, settle, archive, or mark a thread unread. Omit `threadId` for this thread. `snooze` needs `snoozedUntil`. Settling this thread applies at turn end. A failed turn or queued message leaves it active.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
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
  success: Schema.Union([
    OrchestrationV2DispatchCommandResult,
    Schema.Struct({ settlesWhenTurnEnds: Schema.Literal(true) }),
  ]),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    SecureRandom.SecureRandom,
  ],
})
  .annotate(Tool.Title, "Organize a thread")
  .annotate(Tool.Strict, true)
  .annotate(Tool.Destructive, true);

const commandTool = {
  success: OrchestrationV2DispatchCommandResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    SecureRandom.SecureRandom,
  ],
};
const queueEntry = Schema.Struct({
  queuedRunId: RunId,
  text: Schema.String,
  truncated: Schema.Boolean,
});
const QUEUE_READ_ACTIONS = ["list", "read"] as const;
const QueueTool = Tool.make("t3_queue", {
  ...commandTool,
  description:
    "Manage a thread's queued messages. Omit `threadId` for this thread. list: send order, paged by `cursor` and `limit`. read: up to 16,000 chars of one. edit: replace its `text`; attachments stay. cancel. reorder: before `beforeRunId`, or to the end with null. promote_to_steer: send it now as steering to active `targetRunId`. Writes fail once the run is no longer queued.",
  parameters: Schema.Struct({
    action: Schema.Literals([
      ...QUEUE_READ_ACTIONS,
      "edit",
      "cancel",
      "reorder",
      "promote_to_steer",
    ]),
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    queuedRunId: Schema.optional(RunId),
    text: Schema.optional(Schema.String.check(Schema.isMaxLength(100000))),
    beforeRunId: Schema.optional(Schema.NullOr(RunId)),
    targetRunId: Schema.optional(RunId),
    cursor: Schema.optional(NonNegativeInt),
    limit: Schema.optional(clampedPositiveInt(100)),
  }),
  success: Schema.Union([
    Schema.Struct({ items: Schema.Array(queueEntry), nextCursor: Schema.NullOr(NonNegativeInt) }),
    queueEntry,
    OrchestrationV2DispatchCommandResult,
  ]),
}).annotate(Tool.Destructive, true);

const question = Schema.Struct({
  id: Schema.String,
  header: Schema.String,
  question: Schema.String,
  options: Schema.Array(
    Schema.Struct({
      label: Schema.String,
      description: Schema.String,
      value: Schema.optional(Schema.String),
      preview: Schema.optional(Schema.String),
    }),
  ),
  multiSelect: Schema.optional(Schema.Boolean),
  allowCustomAnswer: Schema.optional(Schema.Boolean),
  initialAnswer: Schema.optional(Schema.String),
  required: Schema.optional(Schema.Boolean),
});
const PendingRequestTool = Tool.make("t3_pending_request", {
  ...commandTool,
  description:
    "Pending user questions in a thread. Omit `threadId` for this thread. list: their ids; approvals are not listed. read: one by `requestId`. respond: answer one with `answers`; this cannot approve a permission request.",
  parameters: Schema.Struct({
    action: Schema.Literals(["list", "read", "respond"]),
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    requestId: Schema.optional(RuntimeRequestId),
    answers: Schema.optional(ProviderUserInputAnswers),
  }),
  success: Schema.Union([
    Schema.Struct({ requestIds: Schema.Array(RuntimeRequestId) }),
    Schema.Struct({ requestId: RuntimeRequestId, questions: Schema.Array(question) }),
    OrchestrationV2DispatchCommandResult,
  ]),
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const threadConfiguration = Schema.Struct({
  threadId: ThreadId,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});
const ThreadConfigureTool = Tool.make("t3_thread_configure", {
  ...commandTool,
  description:
    "Read a thread's provider, model, and modes, or set its provider, model, and options with `modelSelection`. Omit `threadId` for this thread. Permission modes stay. Values from `orchestrator_capabilities`.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    modelSelection: Schema.optional(ModelSelection),
  }),
  success: Schema.Union([threadConfiguration, OrchestrationV2DispatchCommandResult]),
}).annotate(Tool.Destructive, true);

const ThreadGroupTool = Tool.make("t3_thread_group", {
  ...commandTool,
  description:
    "Bring models from any provider into a visible thread as peers who talk to the user and each other, for a shared discussion. To hand off work, use `delegate_task`. Omit `threadId` for this thread. status: read the group. invite: seat `modelSelection`, with values from `orchestrator_capabilities`; fails while group conversations are off in Settings. remove: the seat `handle`. discuss: say `message` to everyone, or only to the `to` handles. end: the thread's own model continues with the full discussion in context.",
  parameters: Schema.Struct({
    action: Schema.Literals(["status", "invite", "remove", "discuss", "end"]),
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    modelSelection: Schema.optional(ModelSelection),
    handle: Schema.optional(TrimmedNonEmptyString),
    message: Schema.optional(Schema.String.check(Schema.isMaxLength(100000))),
    to: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  }),
  success: Schema.NullOr(OrchestrationV2ThreadGroup),
  dependencies: [...commandTool.dependencies, ThreadGroupService.ThreadGroupService],
}).annotate(Tool.Destructive, true);

const ThreadTransferTool = Tool.make("t3_thread_transfer", {
  ...commandTool,
  description:
    "Move context between threads. Omit `threadId` for this thread. fork: copy it from `sourcePoint` (default latest stable run) into a new thread with the same setup; no turn runs yet. merge_back: merge it from `sourcePoint` into a related `targetThreadId` in the same project. status: its context transfers.",
  parameters: Schema.Struct({
    action: Schema.Literals(["fork", "merge_back", "status"]),
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    sourcePoint: Schema.optional(OrchestrationV2ThreadForkSourcePoint),
    targetThreadId: Schema.optional(ThreadId),
    title: Schema.optional(TrimmedNonEmptyString),
  }),
  success: Schema.Union([
    Schema.Struct({ sequence: NonNegativeInt, targetThreadId: ThreadId }),
    Schema.Struct({
      transfers: Schema.Array(
        Schema.Struct({
          id: OrchestrationV2ContextTransfer.fields.id,
          sourceThreadId: OrchestrationV2ContextTransfer.fields.sourceThreadId,
          targetThreadId: OrchestrationV2ContextTransfer.fields.targetThreadId,
          status: OrchestrationV2ContextTransfer.fields.status,
        }),
      ),
    }),
  ]),
}).annotate(Tool.Destructive, true);

const ThreadSearchTool = Tool.make("t3_thread_search", {
  ...commandTool,
  description:
    "Search finished user and assistant messages, or with source=tools finished tool output. Every word must appear in one result; quote to keep a phrase. complete=false: older output is still indexing. Project scope applies before the limit. Omit projectId to use the calling thread project. Callers outside a thread search all projects when projectId is absent. Archived threads require includeArchived. Continue with nextCursor using the same query and scope. Each thread contributes one matching item. Search compressed history with t3_conversation_summary_search. Read around a hit: t3_thread_read with its itemId and view=activity, then afterPosition or beforePosition and a small limit.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...OrchestrationSearchThreadsInput.fields,
    projectId: Schema.optional(ProjectId),
    source: Schema.optional(Schema.Literals(["messages", "tools"])),
  }),
  success: Schema.Struct({
    ...OrchestrationSearchThreadsResult.fields,
    currentThreadId: Schema.optional(Schema.NullOr(ThreadId)),
    matches: Schema.Array(
      Schema.Union([
        Schema.Struct({
          ...OrchestrationThreadSearchMatch.fields,
          link: Schema.optional(Schema.String),
        }),
        Schema.Struct({
          ...ToolSearch.ToolSearchMatch.fields,
          link: Schema.optional(Schema.String),
        }),
      ]),
    ),
    complete: Schema.optional(Schema.Boolean),
  }),
  dependencies: [...commandTool.dependencies, ThreadSearch.ThreadSearch, ToolSearch.ToolSearch],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const ScheduledTaskRunTool = Tool.make("run_scheduled_task_now", {
  ...commandTool,
  description:
    "Run one scheduled task now. Needs a full-access or default caller. Returns its thread, or null if not started. Success means started, not finished.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    taskId: ScheduledTaskId,
  }),
  success: Schema.Struct({
    taskId: ScheduledTaskId,
    threadId: ScheduledTask.fields.threadId,
    link: Schema.optional(Schema.String),
    lastRunStatus: ScheduledTask.fields.lastRunStatus,
    lastRunError: ScheduledTask.fields.lastRunError,
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
  ThreadConfigureTool,
  ThreadGroupTool,
  ThreadTransferTool,
  ThreadOrganizeTool,
  PendingRequestTool,
  QueueTool,
);
