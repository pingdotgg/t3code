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
  /** When a paused run is resumed without anyone asking; null when it waits for a person. */
  resumesAt: Schema.NullOr(Schema.String),
  /** The run that invoked this one and waits for it; null for a run started by itself. */
  parentRunId: Schema.NullOr(Schema.String),
  /** The step of that run this one was invoked as. */
  parentStep: Schema.NullOr(Schema.String),
  startedAt: Schema.String,
  updatedAt: Schema.String,
  endedAt: Schema.NullOr(Schema.String),
});
export type WorkflowRun = typeof WorkflowRun.Type;

export const WorkflowStep = Schema.Struct({
  name: Schema.String,
  // A sleep's `detail` is when it wakes, as an ISO time.
  kind: Schema.Literals(["step", "wait", "agent", "ask", "sleep"]),
  status: Schema.Literals(["running", "completed", "failed"]),
  attempts: Schema.Number,
  detail: Schema.NullOr(Schema.String),
  /** The thread an agent step ran in. */
  threadId: Schema.NullOr(Schema.String),
  /** The linked environment that thread is in; null when it is this one. */
  environmentId: Schema.NullOr(Schema.String),
  /** What it produced: a step's value, an agent's data or reply, the answer to a question. */
  result: Schema.NullOr(Schema.Json),
  /** What an agent said in closing, when its result is data and not that reply. */
  said: Schema.NullOr(Schema.String),
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
  /** The run's latest agent thread, for talking it through before answering. */
  thread: Schema.NullOr(
    Schema.Struct({ threadId: Schema.String, environmentId: Schema.NullOr(Schema.String) }),
  ),
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
/** A workflow this server has registered, at its newest version, and what starts it. */
export const WorkflowSummary = Schema.Struct({
  name: Schema.String,
  version: Schema.Number,
  /** In words: "every 1h", "daily at 09:00", "webhook issues". Empty when only started by hand. */
  triggers: Schema.Array(Schema.String),
});
export type WorkflowSummary = typeof WorkflowSummary.Type;

/** Something wrong with the definitions: in `file` when it is one file's, at `line` when it names one. */
export const WorkflowDefinitionProblem = Schema.Struct({
  message: Schema.String,
  file: Schema.optional(Schema.String),
  line: Schema.optional(Schema.Number),
});
export type WorkflowDefinitionProblem = typeof WorkflowDefinitionProblem.Type;

/** Which loading of the definitions file is running, and what is wrong with the file now. */
export const WorkflowDefinitionState = Schema.Struct({
  /** Goes up whenever the file is loaded or found wrong, so a client knows to read it again. */
  revision: Schema.Number,
  /** Why the file on disk is not what runs. The last version that loaded keeps running. */
  problem: Schema.NullOr(Schema.String),
});

export const WorkflowDefinitionFile = Schema.Struct({
  name: Schema.String,
  /** The file as it is on disk, which is not what runs while it has problems. */
  source: Schema.String,
  /** The workflows its last good version defines, each as `name@version`. */
  workflows: Schema.Array(Schema.String),
  problems: Schema.Array(WorkflowDefinitionProblem),
});
export type WorkflowDefinitionFile = typeof WorkflowDefinitionFile.Type;

/** The files that define this server's workflows. */
export const WorkflowDefinitionFiles = Schema.Struct({
  /** The folder the files are in. */
  directory: Schema.String,
  /** The server was pointed at one file: no file can be added beside it or taken away. */
  single: Schema.Boolean,
  files: Schema.Array(WorkflowDefinitionFile),
  /** What is wrong between files, such as one workflow defined in two of them. */
  problems: Schema.Array(WorkflowDefinitionProblem),
  ...WorkflowDefinitionState.fields,
});
export type WorkflowDefinitionFiles = typeof WorkflowDefinitionFiles.Type;

export const WorkflowDefinitionGetInput = Schema.Struct({});
/** A file by its name in the folder. Saving a name that is not there yet makes the file. */
export const WorkflowDefinitionSaveInput = Schema.Struct({
  name: Schema.String,
  source: Schema.String,
});
export const WorkflowDefinitionDeleteInput = Schema.Struct({ name: Schema.String });
export const WorkflowDefinitionChangeResult = Schema.Struct({
  /** Empty when the change was made and is what runs now. Otherwise nothing changed. */
  problems: Schema.Array(WorkflowDefinitionProblem),
});
export type WorkflowDefinitionChangeResult = typeof WorkflowDefinitionChangeResult.Type;

export const WorkflowRunsSnapshot = Schema.Struct({
  workflows: Schema.Array(WorkflowSummary),
  runs: Schema.Array(WorkflowRun),
  questions: Schema.Array(WorkflowQuestion),
  definition: Schema.optional(WorkflowDefinitionState),
});

/** How much is going on, for a badge that must not cost a list of runs to keep current. */
export const WorkflowCounts = Schema.Struct({
  /** Open questions and paused runs: what waits on a person. */
  needsYou: Schema.Number,
  /** Runs that have not ended. */
  active: Schema.Number,
  /** Runs there have ever been, so a client knows whether workflows are in use at all. */
  total: Schema.Number,
});
export type WorkflowCounts = typeof WorkflowCounts.Type;
export type WorkflowRunsSnapshot = typeof WorkflowRunsSnapshot.Type;

export const WorkflowRunsSubscribeInput = Schema.Struct({});

export const WorkflowRunGetInput = Schema.Struct({ runId: Schema.String });

/** One run with its steps, in the order they started. */
export const WorkflowRunDetail = Schema.Struct({
  run: WorkflowRun,
  steps: Schema.Array(WorkflowStep),
});
export type WorkflowRunDetail = typeof WorkflowRunDetail.Type;

/** A person's answer to a `WorkflowQuestion`: one of its choices and, if they gave one, why. */
export const WorkflowAnswerInput = Schema.Struct({
  runId: Schema.String,
  name: Schema.String,
  choice: Schema.String,
  reason: Schema.optional(Schema.String),
});

export const WorkflowRunResumeInput = Schema.Struct({ runId: Schema.String });

export const WorkflowRunCancelInput = Schema.Struct({
  runId: Schema.String,
  reason: Schema.optional(Schema.String),
});

export class WorkflowRequestError extends Schema.TaggedError<WorkflowRequestError>()(
  "WorkflowRequestError",
  { message: Schema.String },
) {}
