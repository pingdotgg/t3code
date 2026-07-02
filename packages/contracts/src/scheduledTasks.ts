import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";
import { ModelSelection, ProviderInteractionMode, RuntimeMode } from "./orchestration.ts";

export const ScheduledTaskId = TrimmedNonEmptyString.pipe(Schema.brand("ScheduledTaskId"));
export type ScheduledTaskId = typeof ScheduledTaskId.Type;

export const ScheduledTaskCadence = Schema.Literals(["hourly", "daily", "weekly", "monthly"]);
export type ScheduledTaskCadence = typeof ScheduledTaskCadence.Type;

export const ScheduledTaskRunStatus = Schema.Literals(["succeeded", "failed"]);
export type ScheduledTaskRunStatus = typeof ScheduledTaskRunStatus.Type;

export const ScheduledTaskRunState = Schema.Literals([
  "pending_manual_run",
  "scheduled",
  "disabled",
  "running",
]);
export type ScheduledTaskRunState = typeof ScheduledTaskRunState.Type;

export const ScheduledTaskLocalWorkspace = Schema.Struct({
  mode: Schema.Literal("local"),
  worktreePath: Schema.NullOr(TrimmedString),
});
export type ScheduledTaskLocalWorkspace = typeof ScheduledTaskLocalWorkspace.Type;

export const ScheduledTaskWorktreeWorkspace = Schema.Struct({
  mode: Schema.Literal("worktree"),
  baseBranch: TrimmedNonEmptyString,
  startFromOrigin: Schema.Boolean,
});
export type ScheduledTaskWorktreeWorkspace = typeof ScheduledTaskWorktreeWorkspace.Type;

export const ScheduledTaskWorkspace = Schema.Union([
  ScheduledTaskLocalWorkspace,
  ScheduledTaskWorktreeWorkspace,
]);
export type ScheduledTaskWorkspace = typeof ScheduledTaskWorkspace.Type;

export const ScheduledTaskProjectTarget = Schema.Struct({
  type: Schema.Literal("project"),
  projectId: ProjectId,
  workspace: ScheduledTaskWorkspace,
});
export type ScheduledTaskProjectTarget = typeof ScheduledTaskProjectTarget.Type;

export const ScheduledTaskStandaloneTarget = Schema.Struct({
  type: Schema.Literal("standalone"),
});
export type ScheduledTaskStandaloneTarget = typeof ScheduledTaskStandaloneTarget.Type;

export const ScheduledTaskTarget = Schema.Union([
  ScheduledTaskProjectTarget,
  ScheduledTaskStandaloneTarget,
]);
export type ScheduledTaskTarget = typeof ScheduledTaskTarget.Type;

export const ScheduledAgentTask = Schema.Struct({
  id: ScheduledTaskId,
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  cadence: ScheduledTaskCadence,
  target: ScheduledTaskTarget,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastStartedAt: Schema.NullOr(IsoDateTime),
  lastFinishedAt: Schema.NullOr(IsoDateTime),
  lastStatus: Schema.NullOr(ScheduledTaskRunStatus),
  lastError: Schema.NullOr(Schema.String),
  lastThreadId: Schema.NullOr(ThreadId),
});
export type ScheduledAgentTask = typeof ScheduledAgentTask.Type;

export const ScheduledTaskSnapshot = Schema.Struct({
  ...ScheduledAgentTask.fields,
  runState: ScheduledTaskRunState,
  nextRunAt: Schema.NullOr(IsoDateTime),
});
export type ScheduledTaskSnapshot = typeof ScheduledTaskSnapshot.Type;

const ScheduledTaskWritableFields = {
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  cadence: ScheduledTaskCadence,
  target: ScheduledTaskTarget,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
} as const;

export const ScheduledTaskCreateInput = Schema.Struct(ScheduledTaskWritableFields);
export type ScheduledTaskCreateInput = typeof ScheduledTaskCreateInput.Type;

export const ScheduledTaskUpdateInput = Schema.Struct({
  id: ScheduledTaskId,
  patch: Schema.Struct({
    title: Schema.optionalKey(ScheduledTaskWritableFields.title),
    prompt: Schema.optionalKey(ScheduledTaskWritableFields.prompt),
    enabled: Schema.optionalKey(ScheduledTaskWritableFields.enabled),
    cadence: Schema.optionalKey(ScheduledTaskWritableFields.cadence),
    target: Schema.optionalKey(ScheduledTaskWritableFields.target),
    modelSelection: Schema.optionalKey(ScheduledTaskWritableFields.modelSelection),
    runtimeMode: Schema.optionalKey(ScheduledTaskWritableFields.runtimeMode),
    interactionMode: Schema.optionalKey(ScheduledTaskWritableFields.interactionMode),
  }),
});
export type ScheduledTaskUpdateInput = typeof ScheduledTaskUpdateInput.Type;

export const ScheduledTaskDeleteInput = Schema.Struct({
  id: ScheduledTaskId,
});
export type ScheduledTaskDeleteInput = typeof ScheduledTaskDeleteInput.Type;

export const ScheduledTaskRunNowInput = Schema.Struct({
  id: ScheduledTaskId,
});
export type ScheduledTaskRunNowInput = typeof ScheduledTaskRunNowInput.Type;

export const ScheduledTaskListResult = Schema.Struct({
  tasks: Schema.Array(ScheduledTaskSnapshot),
});
export type ScheduledTaskListResult = typeof ScheduledTaskListResult.Type;

export const ScheduledTaskMutationResult = Schema.Struct({
  task: ScheduledTaskSnapshot,
  tasks: Schema.Array(ScheduledTaskSnapshot),
});
export type ScheduledTaskMutationResult = typeof ScheduledTaskMutationResult.Type;

export const ScheduledTaskDeleteResult = ScheduledTaskListResult;
export type ScheduledTaskDeleteResult = typeof ScheduledTaskDeleteResult.Type;

export class ScheduledTaskError extends Schema.TaggedErrorClass<ScheduledTaskError>()(
  "ScheduledTaskError",
  {
    operation: Schema.Literals(["read", "write", "create", "update", "delete", "run", "list"]),
    taskId: Schema.optional(ScheduledTaskId),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
