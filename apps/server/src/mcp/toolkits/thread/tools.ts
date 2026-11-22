import {
  OrchestratorMcpEnvironmentTarget,
  ScheduledTaskId,
  ScheduledTask,
  OrchestrationSearchThreadsInput,
  OrchestrationThreadSearchMatch,
  OrchestrationV2ThreadForkSourcePoint,
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
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const ThreadOrganizeTool = Tool.make("t3_thread_organize", {
  description:
    "Pin, snooze, settle, archive or mark unread. Omit `threadId` for this thread. `snooze` needs `snoozedUntil`. Settling this thread waits till turn end; failures or queued input leave it active.",
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
    "Manage queued messages. Omit `threadId` for this thread. `list` returns send order, paged by `cursor`/`limit`; `read` returns one (max 16,000 chars). `edit` replaces `text` (attachments stay); `cancel`; `reorder` before `beforeRunId` or to the end with null; `promote_to_steer` sends now as steering to active `targetRunId`. Writes fail after the run leaves queued.",
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
    "List pending user questions (not approvals), read one by `requestId`, or respond with `answers`. Omit `threadId` for this thread; responding cannot approve permission requests.",
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
    "Read provider, model, and modes or set provider, model, and options with `modelSelection`. Omit `threadId` for this thread. Permission modes stay; values come from `orchestrator_capabilities`.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    modelSelection: Schema.optional(ModelSelection),
  }),
  success: Schema.Union([threadConfiguration, OrchestrationV2DispatchCommandResult]),
}).annotate(Tool.Destructive, true);

const ThreadTransferTool = Tool.make("t3_thread_transfer", {
  ...commandTool,
  description:
    "Fork copies `sourcePoint` (latest stable run by default) to a new thread; no turn starts. Merge back merges `sourcePoint` into required parent `targetThreadId`. Status lists transfers. Continue without `handoff` checks opt-in; with one, queues fresh context for this top-level thread after a successful turn and settled delegated work. A queued message or changed source cancels it. Omit `threadId` for this thread.",
  parameters: Schema.Struct({
    action: Schema.Literals(["fork", "merge_back", "status", "continue"]),
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    sourcePoint: Schema.optional(OrchestrationV2ThreadForkSourcePoint),
    targetThreadId: Schema.optional(ThreadId),
    title: Schema.optional(TrimmedNonEmptyString),
    handoff: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(24000))),
  }),
  success: Schema.Union([
    Schema.Struct({ sequence: NonNegativeInt, targetThreadId: ThreadId }),
    Schema.Struct({
      enabled: Schema.Boolean,
      targetThreadId: Schema.optional(ThreadId),
      link: Schema.optional(Schema.String),
      continuesWhenTurnEnds: Schema.optional(Schema.Literal(true)),
    }),
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
    "Search active threads by title, branch, PR, project or message text; excludes subagents. `projectId` selects one project; otherwise this thread's project, then all projects outside a thread. Not exhaustive.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...OrchestrationSearchThreadsInput.fields,
    projectId: Schema.optional(ProjectId),
  }),
  success: Schema.Struct({
    currentThreadId: Schema.optional(Schema.NullOr(ThreadId)),
    matches: Schema.Array(
      Schema.Struct({
        threadId: OrchestrationThreadSearchMatch.fields.threadId,
        projectId: OrchestrationThreadSearchMatch.fields.projectId,
        title: Schema.String,
        link: Schema.optional(Schema.String),
        source: Schema.Literals(["title", "user", "assistant"]),
        snippet: Schema.optional(OrchestrationThreadSearchMatch.fields.snippet),
        messageCreatedAt: Schema.optional(OrchestrationThreadSearchMatch.fields.messageCreatedAt),
      }),
    ),
  }),
  dependencies: [...commandTool.dependencies, ThreadSearch.ThreadSearch],
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

const SubmitOutputTool = Tool.make("t3_submit_output", {
  ...commandTool,
  description:
    "Return this turn's result as data, when the message asked for one. `json`: JSON text matching the schema it gave. A rejection says what did not fit; fix it and call again.",
  // Stored on the run, which every client of the thread holds.
  parameters: Schema.Struct({ json: Schema.String.check(Schema.isMaxLength(200000)) }),
  success: Schema.Struct({ runId: RunId }),
})
  // It writes only the caller's own run, so a read-only or plan-mode agent can still answer.
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const ThreadToolkit = Toolkit.make(
  ScheduledTaskRunTool,
  ThreadSearchTool,
  ThreadConfigureTool,
  ThreadTransferTool,
  ThreadOrganizeTool,
  PendingRequestTool,
  QueueTool,
  SubmitOutputTool,
);
