import * as Schema from "effect/Schema";

export const WorkflowRunStatus = Schema.Literals([
  "running",
  "waiting",
  "paused",
  "completed",
  "stopped",
  "cancelled",
]);
export type WorkflowRunStatus = typeof WorkflowRunStatus.Type;

export const WorkflowRun = Schema.Struct({
  runId: Schema.String,
  workflow: Schema.String,
  version: Schema.Number,
  title: Schema.String,
  status: WorkflowRunStatus,
  /** Why it is paused, what it waits on, or how it ended. */
  detail: Schema.NullOr(Schema.String),
  result: Schema.NullOr(Schema.Json),
  /** How many times in a row it has been paused by a failing step. */
  pauses: Schema.Number,
  /** Its version is no longer registered, so it cannot go on until that version is back. */
  retired: Schema.Boolean,
  startedAt: Schema.String,
  updatedAt: Schema.String,
  endedAt: Schema.NullOr(Schema.String),
});
export type WorkflowRun = typeof WorkflowRun.Type;

export const WorkflowStep = Schema.Struct({
  name: Schema.String,
  kind: Schema.Literals(["step", "wait", "agent", "ask"]),
  status: Schema.Literals(["running", "completed", "failed"]),
  attempts: Schema.Number,
  detail: Schema.NullOr(Schema.String),
  /** The thread an agent step ran in. */
  threadId: Schema.NullOr(Schema.String),
  startedAt: Schema.String,
  endedAt: Schema.NullOr(Schema.String),
});
export type WorkflowStep = typeof WorkflowStep.Type;

/** A question a run asked. Answer it with a signal to its run and name. */
export const WorkflowQuestion = Schema.Struct({
  runId: Schema.String,
  name: Schema.String,
  /** What `ask` was given: a title, the choices, and data to lay out. */
  request: Schema.Json,
  askedAt: Schema.String,
});
export type WorkflowQuestion = typeof WorkflowQuestion.Type;

/** Where a workflow takes requests. `path` holds the hook's secret. */
export const WorkflowHook = Schema.Struct({
  workflow: Schema.String,
  name: Schema.String,
  path: Schema.String,
});
export type WorkflowHook = typeof WorkflowHook.Type;

/** What a client shows of workflows: recent runs, newest first, and the questions still open. */
export const WorkflowRunsSnapshot = Schema.Struct({
  runs: Schema.Array(WorkflowRun),
  questions: Schema.Array(WorkflowQuestion),
});
export type WorkflowRunsSnapshot = typeof WorkflowRunsSnapshot.Type;

export const WorkflowRunsSubscribeInput = Schema.Struct({});
