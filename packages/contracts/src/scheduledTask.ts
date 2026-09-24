import * as Schema from "effect/Schema";

import {
  CommandId,
  IsoDateTime,
  ProjectId,
  RunId,
  ScheduledTaskId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import {
  OrchestrationV2Actor,
  OrchestrationV2CreationSource,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
} from "./orchestrationV2.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

/** 24-hour "HH:MM" wall-clock time. Mirrors `parseTimeOfDay` on the server. */
const TimeOfDay = TrimmedNonEmptyString.check(
  Schema.isPattern(/^([01]?\d|2[0-3]):([0-5]\d)$/),
).annotate({ description: "Local wall-clock time in 24-hour HH:MM form, such as 09:30." });

export const MIN_SCHEDULED_TASK_INTERVAL_MS = 60_000;

const ScheduledTaskIntervalMs = Schema.Int.check(Schema.isGreaterThan(0)).annotate({
  description: "Positive interval in milliseconds.",
});

const ScheduledTaskIntervalSchedule = Schema.Struct({
  type: Schema.Literal("interval").annotate({
    description: "Select interval scheduling.",
  }),
  everyMs: ScheduledTaskIntervalMs,
}).annotate({
  description: "Run repeatedly after a fixed number of milliseconds.",
});

const ScheduledTaskFixedTimeSchedule = Schema.Struct({
  type: Schema.Literal("fixed_time").annotate({
    description: "Select a fixed local wall-clock time.",
  }),
  timeOfDay: TimeOfDay,
  weekdays: Schema.optional(
    Schema.Array(
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 })).annotate({
        description: "Weekday number where 0 is Sunday and 6 is Saturday.",
      }),
    ).annotate({
      description: "Optional weekdays; omit to run every day.",
    }),
  ),
}).annotate({
  description: "Run at a fixed local wall-clock time on selected weekdays.",
});

/**
 * Read model for persisted schedules. Keep accepting legacy sub-minute rows so
 * users can list, disable, edit, or delete them after the write minimum changes.
 */
export const ScheduledTaskSchedule = Schema.Union([
  ScheduledTaskIntervalSchedule,
  ScheduledTaskFixedTimeSchedule,
]).annotate({
  description:
    "Structured recurring schedule. Pass an object with type 'interval' or 'fixed_time'.",
});
export type ScheduledTaskSchedule = typeof ScheduledTaskSchedule.Type;

/** Mutation model: newly created or updated interval schedules run at most once per minute. */
export const ScheduledTaskUpsertSchedule = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("interval").annotate({
      description: "Select interval scheduling.",
    }),
    everyMs: ScheduledTaskIntervalMs.check(
      Schema.isGreaterThanOrEqualTo(MIN_SCHEDULED_TASK_INTERVAL_MS),
    ).annotate({
      description: "Interval in milliseconds, with a minimum of 60000 (one minute).",
    }),
  }).annotate({
    description: "Run repeatedly after a fixed number of milliseconds.",
  }),
  ScheduledTaskFixedTimeSchedule,
]).annotate({
  description: "Writable recurring schedule. Pass an object with type 'interval' or 'fixed_time'.",
});
export type ScheduledTaskUpsertSchedule = typeof ScheduledTaskUpsertSchedule.Type;

export const ScheduledTaskRunStatus = Schema.Literals(["never", "running", "succeeded", "failed"]);
export type ScheduledTaskRunStatus = typeof ScheduledTaskRunStatus.Type;

export const ScheduledTask = Schema.Struct({
  id: ScheduledTaskId,
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  schedule: ScheduledTaskSchedule,
  projectId: ProjectId,
  threadId: Schema.NullOr(ThreadId),
  workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  createdBy: OrchestrationV2Actor,
  creationSource: OrchestrationV2CreationSource,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  nextRunAt: Schema.NullOr(IsoDateTime),
  lastRunAt: Schema.NullOr(IsoDateTime),
  lastRunStatus: ScheduledTaskRunStatus,
  lastRunError: Schema.NullOr(Schema.String),
  runCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ScheduledTask = typeof ScheduledTask.Type;

export const ScheduledTaskListInput = Schema.Struct({});
export type ScheduledTaskListInput = typeof ScheduledTaskListInput.Type;

export const ScheduledTaskListResult = Schema.Struct({
  tasks: Schema.Array(ScheduledTask),
});
export type ScheduledTaskListResult = typeof ScheduledTaskListResult.Type;

/**
 * Pins the live caller-owned run a schedule mutation was authorized under.
 * Re-checked inside the write transaction: a mutation that commits after the
 * provider run settled is rejected instead of carrying a dead run's
 * authorization into unattended state.
 */
const ScheduledTaskExpectedActiveRun = Schema.Struct({
  id: RunId,
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
});

/**
 * Pins the calling thread's modes at the time the mutation was authorized.
 * Re-read inside the write transaction so a runtime/interaction-mode change
 * on the caller racing the authorization fails the write instead of arming
 * work the caller can no longer run — e.g. an unbound task that copied the
 * caller's modes before the caller switched to plan.
 */
const ScheduledTaskExpectedCaller = Schema.Struct({
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});

export const ScheduledTaskUpsertInput = Schema.Struct({
  id: Schema.optional(ScheduledTaskId),
  requireExisting: Schema.optional(Schema.Boolean).annotate({
    description: "Reject the save if the task no longer exists, for edits from a client form.",
  }),
  commandId: Schema.optional(CommandId),
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  schedule: ScheduledTaskUpsertSchedule,
  projectId: ProjectId,
  threadId: Schema.optional(Schema.NullOr(ThreadId)),
  workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  createdBy: Schema.optional(OrchestrationV2Actor),
  creationSource: Schema.optional(OrchestrationV2CreationSource),
  expectedActiveRun: Schema.optional(ScheduledTaskExpectedActiveRun),
  // Same atomic precondition as update: the modes the created task's runs
  // execute under — the bound thread's modes — are re-resolved inside the
  // transaction so a concurrent mode change on the destination fails the
  // write rather than persisting a task authorized against a stale snapshot.
  expectedExecutionRuntimeMode: Schema.optional(RuntimeMode),
  expectedExecutionInteractionMode: Schema.optional(ProviderInteractionMode),
  expectedCaller: Schema.optional(ScheduledTaskExpectedCaller),
});
export type ScheduledTaskUpsertInput = typeof ScheduledTaskUpsertInput.Type;

/**
 * Sparse workspace-strategy merge: only the provided keys are applied to the
 * live strategy inside the update transaction, so two clients editing
 * disjoint controls (for example `baseRef` and `startFromOrigin`) keep both
 * changes instead of the second whole-object write reverting the first. A
 * strategy `type` change must send the complete `workspaceStrategy` instead.
 */
export const ScheduledTaskWorkspaceStrategyPatch = Schema.Struct({
  branch: Schema.optional(TrimmedNonEmptyString),
  worktreePath: Schema.optional(TrimmedNonEmptyString),
  baseRef: Schema.optional(TrimmedNonEmptyString),
  startFromOrigin: Schema.optional(Schema.Boolean),
});
export type ScheduledTaskWorkspaceStrategyPatch = typeof ScheduledTaskWorkspaceStrategyPatch.Type;

/**
 * Atomic partial update: only the provided fields are written, and only while
 * the task still exists in `projectId`. Implemented as a targeted UPDATE —
 * never an insert — so an edit racing a delete cannot resurrect the task and
 * disjoint concurrent edits keep their own columns.
 */
export const ScheduledTaskUpdateInput = Schema.Struct({
  id: ScheduledTaskId,
  projectId: ProjectId,
  title: Schema.optional(TrimmedNonEmptyString),
  prompt: Schema.optional(TrimmedNonEmptyString),
  enabled: Schema.optional(Schema.Boolean),
  schedule: Schema.optional(ScheduledTaskUpsertSchedule),
  threadId: Schema.optional(Schema.NullOr(ThreadId)),
  workspaceStrategy: Schema.optional(OrchestrationV2ThreadLaunchWorkspaceStrategy),
  workspaceStrategyPatch: Schema.optional(ScheduledTaskWorkspaceStrategyPatch),
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: Schema.optional(RuntimeMode),
  /** Moves the task to another project; `projectId` stays the lookup scope. */
  nextProjectId: Schema.optional(ProjectId),
  // Optimistic preconditions evaluated inside the write transaction: when
  // provided, the update is rejected if the stored row no longer matches.
  // Authorization evaluated against a separately loaded copy stays pinned to
  // the row the write actually applies to.
  expectedThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  expectedRuntimeMode: Schema.optional(RuntimeMode),
  expectedInteractionMode: Schema.optional(ProviderInteractionMode),
  // The modes the task's runs will execute under after this mutation — the
  // post-update destination thread's modes when bound, the task's stored
  // modes when unbound. Re-resolved inside the transaction so a concurrent
  // destination-mode change fails the write rather than elevating past the
  // caller's authorization.
  expectedExecutionRuntimeMode: Schema.optional(RuntimeMode),
  expectedExecutionInteractionMode: Schema.optional(ProviderInteractionMode),
  expectedActiveRun: Schema.optional(ScheduledTaskExpectedActiveRun),
  expectedCaller: Schema.optional(ScheduledTaskExpectedCaller),
});
export type ScheduledTaskUpdateInput = typeof ScheduledTaskUpdateInput.Type;

/** Partial update that flips only the enabled flag — never overwrites other fields. */
export const ScheduledTaskSetEnabledInput = Schema.Struct({
  id: ScheduledTaskId,
  enabled: Schema.Boolean,
});
export type ScheduledTaskSetEnabledInput = typeof ScheduledTaskSetEnabledInput.Type;

export const ScheduledTaskDeleteInput = Schema.Struct({
  id: ScheduledTaskId,
  /**
   * When set, the delete is scoped to this project: the row is deleted only if
   * it still belongs to `projectId`, so a concurrent project move turns the
   * delete into a typed not-found rather than a cross-project delete.
   */
  projectId: Schema.optional(ProjectId),
  // Optimistic preconditions enforced inside the write transaction, as on
  // update: a mutation authorized against a stale row cannot hit a drifted one.
  expectedThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  expectedRuntimeMode: Schema.optional(RuntimeMode),
  expectedInteractionMode: Schema.optional(ProviderInteractionMode),
  expectedExecutionRuntimeMode: Schema.optional(RuntimeMode),
  expectedExecutionInteractionMode: Schema.optional(ProviderInteractionMode),
  expectedActiveRun: Schema.optional(ScheduledTaskExpectedActiveRun),
});
export type ScheduledTaskDeleteInput = typeof ScheduledTaskDeleteInput.Type;

export const ScheduledTaskRunNowInput = Schema.Struct({
  id: ScheduledTaskId,
  /**
   * When set, the dispatch re-read inside the mark-running transaction also
   * requires `project_id = projectId`, so a concurrent project move turns the
   * manual run into a typed not-found instead of firing under the old
   * project's authority.
   */
  projectId: Schema.optional(ProjectId),
  // Re-checked inside the run-claim transaction, so a manual run cannot fire
  // after the caller run that authorized it has settled.
  expectedActiveRun: Schema.optional(ScheduledTaskExpectedActiveRun),
});
export type ScheduledTaskRunNowInput = typeof ScheduledTaskRunNowInput.Type;

export const ScheduledTaskMutationResult = Schema.Struct({
  task: ScheduledTask,
});
export type ScheduledTaskMutationResult = typeof ScheduledTaskMutationResult.Type;

export const ScheduledTaskDeleteResult = Schema.Struct({
  id: ScheduledTaskId,
});
export type ScheduledTaskDeleteResult = typeof ScheduledTaskDeleteResult.Type;

export const ScheduledTaskRunNowResult = Schema.Struct({
  task: ScheduledTask,
});
export type ScheduledTaskRunNowResult = typeof ScheduledTaskRunNowResult.Type;

export class ScheduledTaskError extends Schema.TaggedError<ScheduledTaskError>()(
  "ScheduledTaskError",
  {
    message: Schema.String,
    taskId: Schema.optional(ScheduledTaskId),
    cause: Schema.optional(Schema.Defect()),
  },
) {}
