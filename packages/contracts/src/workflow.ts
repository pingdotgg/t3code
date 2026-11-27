import * as Schema from "effect/Schema";

import { IssueRef } from "./issue.ts";
import { PullRequestRef } from "./pullRequest.ts";

export const WorkflowRunStatus = Schema.Literals([
  "running",
  "waiting",
  "paused",
  "completed",
  "stopped",
  /** Ended by the workflow as not its to do. Lists leave these out unless asked. */
  "skipped",
  "cancelled",
]);
export type WorkflowRunStatus = typeof WorkflowRunStatus.Type;

/**
 * The one thing a run is about, as the workflow declared it: an issue, a pull request, a thread
 * or a web address. Its `kind`, `key` and `address` read as a `WorkflowRunReference`'s.
 */
export const WorkflowRunSubject = Schema.Struct({
  kind: Schema.String,
  key: Schema.String,
  address: Schema.Json,
  /** Empty until something that touched it knew its title. */
  title: Schema.String,
  url: Schema.NullOr(Schema.String),
});
export type WorkflowRunSubject = typeof WorkflowRunSubject.Type;

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
  /** What the workflow tagged the run with, for filtering. Absent for a run with no tags. */
  tags: Schema.optional(Schema.Array(Schema.String)),
  /** What the run is about. Absent for a run that declared nothing. */
  subject: Schema.optional(WorkflowRunSubject),
  startedAt: Schema.String,
  updatedAt: Schema.String,
  endedAt: Schema.NullOr(Schema.String),
});
export type WorkflowRun = typeof WorkflowRun.Type;

export const WorkflowStep = Schema.Struct({
  name: Schema.String,
  // A sleep's `detail` is when it wakes, as an ISO time. A `queue` step waits for a place in a pool.
  kind: Schema.Literals(["step", "wait", "agent", "ask", "sleep", "queue"]),
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
  /** For a `queue` step still waiting, how many asked for a place in its pool before it. */
  ahead: Schema.optional(Schema.Number),
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
  /** The kind of question its workflow declared for it. Absent for a question asked without one. */
  kind: Schema.optional(Schema.String),
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
  /** The kinds of question it declares, in that order, each with its label. Absent when none. */
  asks: Schema.optional(Schema.Array(Schema.Struct({ kind: Schema.String, label: Schema.String }))),
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
  /** The file was written or deleted. */
  changed: Schema.Boolean,
  /** Empty when the change is what runs now. With `changed`, why it does not run yet. */
  problems: Schema.Array(WorkflowDefinitionProblem),
});
export type WorkflowDefinitionChangeResult = typeof WorkflowDefinitionChangeResult.Type;

export const WorkflowRunsSnapshot = Schema.Struct({
  workflows: Schema.Array(WorkflowSummary),
  runs: Schema.Array(WorkflowRun),
  questions: Schema.Array(WorkflowQuestion),
  definition: Schema.optional(WorkflowDefinitionState),
  /** Older runs outside top-level skipped runs were omitted at the list limit. */
  truncated: Schema.optional(Schema.Boolean),
  /** Older top-level skipped runs were omitted at their separate list limit. */
  skippedTruncated: Schema.optional(Schema.Boolean),
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

/** What changed in the runs list since the last frame a watcher was sent. */
export const WorkflowRunsChange = Schema.TaggedStruct("changed", {
  /** Runs new to the list or different from what was last sent. */
  runs: Schema.Array(WorkflowRun),
  /** Runs that left the list. */
  removed: Schema.Array(Schema.String),
  /** Questions newly asked or different from what was last sent. */
  questions: Schema.Array(WorkflowQuestion),
  /** Questions no longer open, by run and question name. */
  closed: Schema.Array(Schema.Struct({ runId: Schema.String, name: Schema.String })),
  truncated: Schema.optional(Schema.Boolean),
  skippedTruncated: Schema.optional(Schema.Boolean),
});

/**
 * A frame of `workflows.subscribe`: the whole list, or with `changes` asked for, what changed
 * since the last frame. A server older than `changes` ignores it and sends whole lists.
 */
export const WorkflowRunsUpdate = Schema.Union([WorkflowRunsSnapshot, WorkflowRunsChange]);
export type WorkflowRunsUpdate = typeof WorkflowRunsUpdate.Type;

/** The list once `update` is applied, in the order the server lists runs: newest first. */
export function applyWorkflowRunsUpdate(
  snapshot: WorkflowRunsSnapshot | undefined,
  update: WorkflowRunsUpdate,
): WorkflowRunsSnapshot {
  if (!("_tag" in update)) return update;
  const base = snapshot ?? { workflows: [], runs: [], questions: [] };
  // Stable sorts, so entries of the same moment keep the order they were sent in.
  const runs = merged(base.runs, update.runs, update.removed, (run) => run.runId).sort(
    (left, right) =>
      left.startedAt === right.startedAt ? 0 : left.startedAt < right.startedAt ? 1 : -1,
  );
  const questions = merged(
    base.questions,
    update.questions,
    update.closed.map(workflowQuestionKey),
    workflowQuestionKey,
  ).sort((left, right) =>
    left.askedAt === right.askedAt ? 0 : left.askedAt < right.askedAt ? -1 : 1,
  );
  const truncated = update.truncated ?? base.truncated;
  const skippedTruncated = update.skippedTruncated ?? base.skippedTruncated;
  return {
    ...base,
    runs,
    questions,
    ...(truncated === undefined ? {} : { truncated }),
    ...(skippedTruncated === undefined ? {} : { skippedTruncated }),
  };
}

/** What names an open question: one run asks one question of a name at a time. */
export const workflowQuestionKey = (question: { readonly runId: string; readonly name: string }) =>
  JSON.stringify([question.runId, question.name]);

/** `held` with `changed` put in place of their earlier versions and `gone` left out. */
function merged<A>(
  held: ReadonlyArray<A>,
  changed: ReadonlyArray<A>,
  gone: ReadonlyArray<string>,
  key: (entry: A) => string,
): Array<A> {
  const fresh = new Map(changed.map((entry) => [key(entry), entry]));
  const left = new Set(gone);
  const kept = held.flatMap((entry) => {
    const id = key(entry);
    if (left.has(id)) return [];
    const next = fresh.get(id);
    fresh.delete(id);
    return [next ?? entry];
  });
  return [...fresh.values(), ...kept];
}

export const WorkflowRunsSubscribeInput = Schema.Struct({
  /** Send what changed after the first list instead of the whole list every time. */
  changes: Schema.optionalKey(Schema.Boolean),
});

export const WorkflowRunGetInput = Schema.Struct({ runId: Schema.String });

/**
 * Runs whose subject is at the web address `subject`, or is the `issue` or `pullRequest` given:
 * a listing and an item's own view do not always write one item's address the same way.
 */
export const WorkflowRunsAboutInput = Schema.Struct({
  subject: Schema.String,
  issue: Schema.optionalKey(IssueRef),
  pullRequest: Schema.optionalKey(PullRequestRef),
});
export type WorkflowRunsAboutInput = typeof WorkflowRunsAboutInput.Type;
/** Those runs, newest first and 500 at most, with the questions they have open. */
export const WorkflowRunsAbout = Schema.Struct({
  runs: Schema.Array(WorkflowRun),
  questions: Schema.Array(WorkflowQuestion),
});
export type WorkflowRunsAbout = typeof WorkflowRunsAbout.Type;

/**
 * Something a run touched: an issue, a pull request, or a kind added later. `kind` is open, so a
 * client shows a kind it does not know by its title and `url`. `key` is the thing's identity in
 * its kind; `address` is whatever that kind needs to open it.
 */
export const WorkflowRunReference = Schema.Struct({
  ...WorkflowRunSubject.fields,
  /** A word for where it stands, such as `open`, `merged` or `closed`. */
  state: Schema.NullOr(Schema.String),
  /** The steps that touched it, in the order they first did. */
  steps: Schema.Array(Schema.String),
  origin: Schema.Literals(["trigger", "step"]),
});
export type WorkflowRunReference = typeof WorkflowRunReference.Type;

/**
 * The kinds of reference runs record today. `address` is an `IssueRef`, a `PullRequestRef`,
 * `{ threadId }` or `{ url }`.
 */
export const WorkflowReferenceKind = {
  issue: "issue",
  pullRequest: "pullRequest",
  thread: "thread",
  url: "url",
} as const;
export const WorkflowIssueAddress = IssueRef;
export const WorkflowPullRequestAddress = PullRequestRef;

/** One run with its steps, in the order they started, and what it touched. */
export const WorkflowRunDetail = Schema.Struct({
  run: WorkflowRun,
  steps: Schema.Array(WorkflowStep),
  references: Schema.Array(WorkflowRunReference),
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
