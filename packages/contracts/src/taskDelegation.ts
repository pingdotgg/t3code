import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./orchestration.ts";

/**
 * Coarse hint a lead agent can attach to a delegated sub-task so the server-side
 * router can pick an appropriate model when no explicit selection is supplied.
 */
export const TaskModelHint = Schema.Literals(["cheap", "balanced", "strong"]);
export type TaskModelHint = typeof TaskModelHint.Type;

/** A single sub-task a lead agent asks the server to run on its behalf. */
export const DelegateTaskInput = Schema.Struct({
  /** Short human-readable label, surfaced in results and (later) UI grouping. */
  label: Schema.optional(TrimmedNonEmptyString),
  /** The instruction handed to the child agent as its user message. */
  prompt: TrimmedNonEmptyString,
  /** Explicit model override; wins over rules and hints when present. */
  modelSelection: Schema.optional(ModelSelection),
  /** Coarse routing hint used when no explicit `modelSelection` is given. */
  modelHint: Schema.optional(TaskModelHint),
});
export type DelegateTaskInput = typeof DelegateTaskInput.Type;

export const DelegateTasksRequest = Schema.Struct({
  tasks: Schema.Array(DelegateTaskInput),
  /** Optional cap on how many sub-tasks run at once. Server clamps to a safe max. */
  maxConcurrency: Schema.optional(Schema.Number),
});
export type DelegateTasksRequest = typeof DelegateTasksRequest.Type;

export const DelegateTaskResultStatus = Schema.Literals(["running", "completed", "error"]);
export type DelegateTaskResultStatus = typeof DelegateTaskResultStatus.Type;

export const DelegateTaskResult = Schema.Struct({
  label: Schema.optional(TrimmedNonEmptyString),
  /** The child thread that ran this sub-task. */
  threadId: ThreadId,
  /** The model the sub-task was routed to (instanceId/model), for transparency. */
  instanceId: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
  status: DelegateTaskResultStatus,
  /** Final assistant message text on success. */
  message: Schema.optional(Schema.String),
  /** Failure detail on error. */
  error: Schema.optional(Schema.String),
});
export type DelegateTaskResult = typeof DelegateTaskResult.Type;

export const DelegateTasksResult = Schema.Struct({
  results: Schema.Array(DelegateTaskResult),
});
export type DelegateTasksResult = typeof DelegateTasksResult.Type;

/**
 * Request to collect results for sub-tasks that were still running when an
 * earlier `delegate_tasks`/`collect_delegated_tasks` call returned. Omit
 * `threadIds` to collect every still-running sub-task spawned from the calling
 * thread.
 */
export const CollectDelegatedTasksRequest = Schema.Struct({
  threadIds: Schema.optional(Schema.Array(ThreadId)),
});
export type CollectDelegatedTasksRequest = typeof CollectDelegatedTasksRequest.Type;

/** Hard ceiling on sub-tasks per `delegate_tasks` call. */
export const MAX_DELEGATED_TASKS = 8;
/** Default and ceiling for concurrent sub-task execution. */
export const DEFAULT_DELEGATION_CONCURRENCY = 4;
