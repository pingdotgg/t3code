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
  clampedPositiveInt,
  OrchestrationV2DispatchCommandResult,
  ThreadId,
  RunId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadGoal,
  ThreadGoalLoopClientCommand,
  ThreadGoalLoopJson,
  ThreadGoalLoopState,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as CheckpointDiffQuery from "../../../checkpointing/CheckpointDiffQuery.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const ThreadOrganizeTool = Tool.make("t3_thread_organize", {
  description:
    "Pin, snooze, settle, archive, mark a thread unread, record a read receipt, or turn its automatic settling on or off. Omit `threadId` for this thread. `snooze` needs `snoozedUntil`. `mark_read` records a read receipt at the thread's current version, clears a passed snooze-wake indicator, and does not count as opening it. Settling this thread applies at turn end. A failed turn or queued message leaves it active.",
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
      "mark_read",
      "mark_unread",
      "enable_auto_settle",
      "disable_auto_settle",
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
const queueAttachment = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
  mimeType: Schema.String,
  sizeBytes: NonNegativeInt,
});
const queueEntry = Schema.Struct({
  queuedRunId: RunId,
  text: Schema.String,
  truncated: Schema.Boolean,
  queueHeld: Schema.Boolean,
  attachmentCount: NonNegativeInt,
  attachments: Schema.Array(queueAttachment),
});
const queueHoldReason = Schema.NullOr(Schema.String.check(Schema.isMaxLength(500)));
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
    Schema.Struct({
      items: Schema.Array(queueEntry),
      nextCursor: Schema.NullOr(NonNegativeInt),
      queueHeld: Schema.Boolean,
      holdReason: queueHoldReason,
    }),
    Schema.Struct({
      ...queueEntry.fields,
      holdReason: queueHoldReason,
    }),
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
    "Pending user questions in a thread. Omit `threadId` for this thread. list: their ids; approvals are not listed. read: one by `requestId`. respond: answer one with `answers`; this cannot approve a permission request. dismiss: drop a pending question; approvals cannot be dismissed.",
  parameters: Schema.Struct({
    action: Schema.Literals(["list", "read", "respond", "dismiss"]),
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
  autoSettle: Schema.Boolean,
  goal: Schema.NullOr(ThreadGoal),
  goalLoop: Schema.NullOr(ThreadGoalLoopJson),
});
const ThreadConfigurationTool = Tool.make("t3_thread_configuration", {
  ...commandTool,
  description:
    "Read a thread's provider, model, modes, automatic settling, goal, and goal loop. Omit `threadId` for this thread.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
  }),
  success: threadConfiguration,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
// Also reads, but writes too, so read-only threads get the read from t3_thread_configuration.
const ThreadConfigureTool = Tool.make("t3_thread_configure", {
  ...commandTool,
  dependencies: [
    ...commandTool.dependencies,
    ProviderRegistry.ProviderRegistry,
    ServerSettings.ServerSettingsService,
  ],
  description:
    "Read a thread's configuration, or set its provider, model, and options with `modelSelection`. Omit `threadId` for this thread. Permission modes stay. Values from `orchestrator_capabilities`.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    modelSelection: Schema.optional(ModelSelection),
  }),
  success: Schema.Union([threadConfiguration, OrchestrationV2DispatchCommandResult]),
}).annotate(Tool.Destructive, true);

const ThreadLowerModesTool = Tool.make("t3_thread_lower_modes", {
  ...commandTool,
  description:
    "Lower a thread's runtime or interaction mode; agents can never raise one. Omit `threadId` for this thread. The two modes apply separately, so one can be refused. Providers that cannot switch in-session (Claude) interrupt a running turn.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    runtimeMode: Schema.optional(RuntimeMode),
    interactionMode: Schema.optional(ProviderInteractionMode),
  }),
}).annotate(Tool.Destructive, true);

const ThreadGoalTool = Tool.make("t3_thread_goal", {
  ...commandTool,
  description:
    "Set or clear (`goal: null`) a thread's goal. Omit `threadId` for this thread. Never starts work: a new goal's loop stays paused until `t3_thread_goal_loop` resumes it. Clearing stops the loop.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    goal: Schema.NullOr(ThreadGoal),
  }),
}).annotate(Tool.Destructive, true);
const ThreadGoalLoopTool = Tool.make("t3_thread_goal_loop", {
  ...commandTool,
  description:
    "Pause, resume, continue, complete, block, or reset a thread's goal loop. Resume, continue, and reset start turns. `expectedState` is the state last read from `t3_thread_configuration` (`idle` if never run); refused on mismatch.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    action: ThreadGoalLoopClientCommand.fields.action,
    expectedState: ThreadGoalLoopState,
    reason: ThreadGoalLoopClientCommand.fields.reason,
  }),
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);
const RunStartTool = Tool.make("t3_run_start", {
  ...commandTool,
  description:
    "Start held work on a stopped thread. `runId` is the run you expect: `retry_preparation` retries its setup, `start_queued` sends it now, `resume_queue` resumes only if it is next. Refused on mismatch.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    action: Schema.Literals(["retry_preparation", "start_queued", "resume_queue"]),
    runId: RunId,
  }),
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

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
    "Search active threads by title, branch, PR, project, then message text. Skips subagent threads. `projectId`: one project, else yours, else all outside a thread. Not exhaustive. With `threadId`: search only that transcript (first/last 17 matching entries); `entryId` is the message id, or item id for plans.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...OrchestrationSearchThreadsInput.fields,
    projectId: Schema.optional(ProjectId),
    threadId: Schema.optional(ThreadId),
  }),
  success: Schema.Union([
    // Per-thread first: a zero-match result also fits the cross-thread shape,
    // which would strip threadId and totalMatches on encode.
    Schema.Struct({
      threadId: ThreadId,
      totalMatches: NonNegativeInt,
      matches: Schema.Array(
        Schema.Struct({
          entryId: TrimmedNonEmptyString,
          runId: Schema.NullOr(RunId),
          startIndex: NonNegativeInt,
          count: NonNegativeInt,
        }),
      ),
    }),
    Schema.Struct({
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
  ]),
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

const ThreadDiffTool = Tool.make("t3_thread_diff", {
  description:
    "Read a thread's checkpoint diff, the same one the app's diff panel shows. `turn`: that one turn's diff; omit for the whole thread up to the latest ready turn.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    turn: Schema.optional(PositiveInt),
    ignoreWhitespace: Schema.optional(Schema.Boolean),
    maxChars: Schema.optional(clampedPositiveInt(200_000)).annotate({
      description: "Max chars of diff, 1 to 200000.",
    }),
  }),
  success: Schema.Struct({
    threadId: ThreadId,
    fromTurnCount: NonNegativeInt,
    toTurnCount: NonNegativeInt,
    latestTurnCount: NonNegativeInt,
    diff: Schema.String,
    truncated: Schema.Boolean,
    totalChars: NonNegativeInt,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    CheckpointDiffQuery.CheckpointDiffQuery,
  ],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadToolkit = Toolkit.make(
  ScheduledTaskRunTool,
  ThreadSearchTool,
  ThreadDiffTool,
  ThreadConfigurationTool,
  ThreadConfigureTool,
  ThreadLowerModesTool,
  ThreadGoalTool,
  ThreadGoalLoopTool,
  RunStartTool,
  ThreadTransferTool,
  ThreadOrganizeTool,
  PendingRequestTool,
  QueueTool,
);
