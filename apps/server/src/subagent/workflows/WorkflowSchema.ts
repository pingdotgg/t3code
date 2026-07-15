import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString, ThreadId } from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";

/**
 * Workflow definition schemas for JSON-based multi-agent orchestration.
 */

export const WorkflowTaskType = Schema.Literals(["spawn", "wait", "send", "aggregate"]);
export type WorkflowTaskType = typeof WorkflowTaskType.Type;

export const WorkflowExecutionMode = Schema.Literals(["sequential", "parallel", "pipeline"]);
export type WorkflowExecutionMode = typeof WorkflowExecutionMode.Type;

export const WorkflowErrorHandling = Schema.Literals(["continue", "abort", "retry"]);
export type WorkflowErrorHandling = typeof WorkflowErrorHandling.Type;

export const WorkflowRetryPolicy = Schema.Struct({
  maxAttempts: Schema.Int.pipe(Schema.between(1, 5)),
  backoffMs: Schema.Int.pipe(Schema.between(100, 10000)),
});
export type WorkflowRetryPolicy = typeof WorkflowRetryPolicy.Type;

export const WorkflowTask = Schema.Struct({
  id: TrimmedNonEmptyString,
  type: WorkflowTaskType,
  provider: Schema.optional(ProviderInstanceId),
  model: Schema.optional(TrimmedNonEmptyString),
  prompt: Schema.optional(TrimmedNonEmptyString),
  dependencies: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  timeout: Schema.optional(Schema.Int.pipe(Schema.between(10, 600))),
  onError: Schema.optional(WorkflowErrorHandling),
  retryPolicy: Schema.optional(WorkflowRetryPolicy),
});
export type WorkflowTask = typeof WorkflowTask.Type;

export const WorkflowPhase = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  tasks: Schema.Array(WorkflowTask),
  execution: WorkflowExecutionMode,
});
export type WorkflowPhase = typeof WorkflowPhase.Type;

export const WorkflowDefinition = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  version: TrimmedNonEmptyString,
  phases: Schema.Array(WorkflowPhase),
  defaultProvider: Schema.optional(ProviderInstanceId),
  parallelismLimit: Schema.optional(Schema.Int.pipe(Schema.between(1, 50))),
});
export type WorkflowDefinition = typeof WorkflowDefinition.Type;

export const WorkflowTaskStatus = Schema.Literals([
  "pending",
  "running",
  "completed",
  "failed",
  "skipped",
]);
export type WorkflowTaskStatus = typeof WorkflowTaskStatus.Type;

export const WorkflowTaskResult = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  status: WorkflowTaskStatus,
  threadId: Schema.optional(ThreadId),
  result: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  startedAt: Schema.optional(Schema.String),
  completedAt: Schema.optional(Schema.String),
  durationMs: Schema.optional(Schema.Int),
  tokens: Schema.optional(Schema.Int),
});
export type WorkflowTaskResult = typeof WorkflowTaskResult.Type;

export const WorkflowPhaseResult = Schema.Struct({
  phaseId: TrimmedNonEmptyString,
  status: Schema.Literals(["pending", "running", "completed", "failed"]),
  tasks: Schema.Array(WorkflowTaskResult),
  startedAt: Schema.optional(Schema.String),
  completedAt: Schema.optional(Schema.String),
  durationMs: Schema.optional(Schema.Int),
});
export type WorkflowPhaseResult = typeof WorkflowPhaseResult.Type;

export const WorkflowExecutionStatus = Schema.Literals([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export type WorkflowExecutionStatus = typeof WorkflowExecutionStatus.Type;

export const WorkflowExecutionResult = Schema.Struct({
  workflowId: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  status: WorkflowExecutionStatus,
  phases: Schema.Array(WorkflowPhaseResult),
  startedAt: Schema.String,
  completedAt: Schema.optional(Schema.String),
  durationMs: Schema.optional(Schema.Int),
  metrics: Schema.Struct({
    totalDurationMs: Schema.Int,
    totalTokens: Schema.Int,
    totalTasks: Schema.Int,
    completedTasks: Schema.Int,
    failedTasks: Schema.Int,
  }),
});
export type WorkflowExecutionResult = typeof WorkflowExecutionResult.Type;

export const WorkflowMetadata = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  version: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type WorkflowMetadata = typeof WorkflowMetadata.Type;
