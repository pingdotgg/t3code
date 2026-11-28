import * as Schema from "effect/Schema";

import {
  GuestMessageId,
  GuestShareId,
  IsoDateTime,
  ProjectId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ThreadPullRequestKey } from "./threadPullRequest.ts";

/**
 * Milestones are the coarse state changes worth telling someone about: a turn ended, an agent
 * waits on a person, a guest asked something, a watched pull request woke its thread.
 * They are derived from the authoritative stores and kept only in memory, so a consumer that
 * needs the full state reads it from those stores.
 */
export const MilestoneId = TrimmedNonEmptyString.pipe(Schema.brand("MilestoneId"));
export type MilestoneId = typeof MilestoneId.Type;

/** Who caused a milestone, as far as the server knows. */
export const MilestoneActor = Schema.Struct({
  type: Schema.Literals(["user", "agent", "system", "guest"]),
  id: Schema.optional(TrimmedNonEmptyString),
  label: Schema.optional(TrimmedNonEmptyString),
});
export type MilestoneActor = typeof MilestoneActor.Type;

const MilestoneEnvelope = Schema.Struct({
  /** Stable for one transition, so publishing it twice is one milestone. */
  id: MilestoneId,
  occurredAt: IsoDateTime,
  projectId: Schema.NullOr(ProjectId),
  threadId: Schema.NullOr(ThreadId),
  parentThreadId: Schema.NullOr(ThreadId),
  actor: MilestoneActor,
  /** A subagent's thread, or a run another run invoked. Muted unless asked for. */
  isSubagentChild: Schema.Boolean,
  /** The workflow run a workflow milestone is about, or whose agent step the thread is. */
  workflowRunId: Schema.optional(TrimmedNonEmptyString),
});

/** `approval` covers command, file and permission prompts; `user_input` covers questions. */
export const MilestoneInputKind = Schema.Literals(["user_input", "approval"]);
export type MilestoneInputKind = typeof MilestoneInputKind.Type;

/** Which workflow run a workflow milestone is about. Its envelope names no project or thread. */
const WorkflowRunFields = {
  workflowRunId: TrimmedNonEmptyString,
  workflow: TrimmedNonEmptyString,
  runTitle: Schema.String,
  /** The run that invoked this one, when one did. */
  parentWorkflowRunId: Schema.NullOr(TrimmedNonEmptyString),
};

export const MilestoneEvent = Schema.Union([
  Schema.Struct({
    ...MilestoneEnvelope.fields,
    type: Schema.Literal("thread.run_settled"),
    runId: RunId,
    outcome: Schema.Literals(["completed", "failed", "interrupted", "cancelled"]),
  }),
  Schema.Struct({
    ...MilestoneEnvelope.fields,
    type: Schema.Literal("thread.needs_input"),
    requestId: RuntimeRequestId,
    kind: MilestoneInputKind,
  }),
  Schema.Struct({
    ...MilestoneEnvelope.fields,
    type: Schema.Literal("thread.input_resolved"),
    requestId: RuntimeRequestId,
    kind: MilestoneInputKind,
    resolution: Schema.Literals(["resolved", "expired", "cancelled"]),
  }),
  Schema.Struct({
    ...MilestoneEnvelope.fields,
    type: Schema.Literal("thread.guest_request"),
    shareId: GuestShareId,
    guestMessageId: GuestMessageId,
  }),
  Schema.Struct({
    ...MilestoneEnvelope.fields,
    type: Schema.Literal("thread.guest_request_resolved"),
    shareId: GuestShareId,
    guestMessageId: GuestMessageId,
    /** `closed` when the link was closed or replaced with the request still waiting. */
    resolution: Schema.Literals(["sent", "dismissed", "closed"]),
  }),
  Schema.Struct({
    ...MilestoneEnvelope.fields,
    type: Schema.Literal("pr.watch_wake"),
    pullRequests: Schema.Array(ThreadPullRequestKey),
    outcome: Schema.Literals(["completed", "failed", "cancelled", "updated", "unknown"]),
    summary: Schema.String,
    /** The watch ended with this wake, as a merge, a close or a read failure ends it. */
    watchEnded: Schema.Boolean,
  }),
  Schema.Struct({
    ...MilestoneEnvelope.fields,
    ...WorkflowRunFields,
    type: Schema.Literal("workflow.run_started"),
  }),
  Schema.Struct({
    ...MilestoneEnvelope.fields,
    ...WorkflowRunFields,
    type: Schema.Literal("workflow.needs_input"),
    /** The step that asks, which answering names. */
    step: TrimmedNonEmptyString,
    question: Schema.String,
  }),
  Schema.Struct({
    ...MilestoneEnvelope.fields,
    ...WorkflowRunFields,
    type: Schema.Literal("workflow.input_resolved"),
    step: TrimmedNonEmptyString,
    /**
     * `cancelled` when the run ended with the question still open; `withdrawn` when it was ended
     * unanswered from outside while the run went on.
     */
    resolution: Schema.Literals(["answered", "expired", "withdrawn", "cancelled"]),
  }),
  Schema.Struct({
    ...MilestoneEnvelope.fields,
    ...WorkflowRunFields,
    type: Schema.Literal("workflow.run_paused"),
    reason: Schema.String,
  }),
  Schema.Struct({
    ...MilestoneEnvelope.fields,
    ...WorkflowRunFields,
    type: Schema.Literal("workflow.run_resumed"),
  }),
  Schema.Struct({
    ...MilestoneEnvelope.fields,
    ...WorkflowRunFields,
    type: Schema.Literal("workflow.run_ended"),
    outcome: Schema.Literals(["completed", "stopped", "skipped", "cancelled"]),
    detail: Schema.NullOr(Schema.String),
  }),
]);
export type MilestoneEvent = typeof MilestoneEvent.Type;

export const MilestoneEventType = Schema.Literals([
  "thread.run_settled",
  "thread.needs_input",
  "thread.input_resolved",
  "thread.guest_request",
  "thread.guest_request_resolved",
  "pr.watch_wake",
  "workflow.run_started",
  "workflow.needs_input",
  "workflow.input_resolved",
  "workflow.run_paused",
  "workflow.run_resumed",
  "workflow.run_ended",
]);
export type MilestoneEventType = typeof MilestoneEventType.Type;

export const MilestoneFilter = Schema.Struct({
  types: Schema.optional(Schema.Array(MilestoneEventType)),
  projectIds: Schema.optional(Schema.Array(ProjectId)),
  threadIds: Schema.optional(Schema.Array(ThreadId)),
  /** Workflow names. Given, it matches only workflow milestones. */
  workflows: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  /** Workflow runs, with the threads that are their agent steps. */
  workflowRunIds: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  /** Absent reads as false: subagent threads and invoked runs churn and are rarely news. */
  includeSubagentChildren: Schema.optional(Schema.Boolean),
});
export type MilestoneFilter = typeof MilestoneFilter.Type;

/** Whether `event` is one `filter` asks for. Each given list must contain the event's value. */
export const milestoneMatches = (event: MilestoneEvent, filter: MilestoneFilter = {}): boolean =>
  (filter.includeSubagentChildren === true || !event.isSubagentChild) &&
  (filter.types === undefined || filter.types.includes(event.type)) &&
  (filter.projectIds === undefined ||
    (event.projectId !== null && filter.projectIds.includes(event.projectId))) &&
  (filter.threadIds === undefined ||
    (event.threadId !== null && filter.threadIds.includes(event.threadId))) &&
  (filter.workflows === undefined ||
    ("workflow" in event && filter.workflows.includes(event.workflow))) &&
  (filter.workflowRunIds === undefined ||
    (event.workflowRunId !== undefined && filter.workflowRunIds.includes(event.workflowRunId)));
