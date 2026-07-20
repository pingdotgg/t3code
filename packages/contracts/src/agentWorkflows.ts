import { Effect } from "effect";
import * as Schema from "effect/Schema";
import {
  CommandId,
  IsoDateTime,
  MessageId,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const ReviewChangesScope = Schema.Literals(["uncommitted", "against-base"]);
export type ReviewChangesScope = typeof ReviewChangesScope.Type;

export const DEFAULT_REVIEW_CHANGES_SCOPE: ReviewChangesScope = "uncommitted";

export const AgentWorkflowTrigger = Schema.Literals(["manual", "after-assistant-turn-completes"]);
export type AgentWorkflowTrigger = typeof AgentWorkflowTrigger.Type;

export const AgentWorkflowDestinationMode = Schema.Literals([
  "same-chat",
  "new-chat",
  "child-chat",
]);
export type AgentWorkflowDestinationMode = typeof AgentWorkflowDestinationMode.Type;

export const WorkflowRunId = TrimmedNonEmptyString.pipe(Schema.brand("WorkflowRunId"));
export type WorkflowRunId = typeof WorkflowRunId.Type;

export const WorkflowNodeId = TrimmedNonEmptyString.pipe(Schema.brand("WorkflowNodeId"));
export type WorkflowNodeId = typeof WorkflowNodeId.Type;

export const WorkflowArtifactId = TrimmedNonEmptyString.pipe(Schema.brand("WorkflowArtifactId"));
export type WorkflowArtifactId = typeof WorkflowArtifactId.Type;

/**
 * A workflow intentionally chooses the minimum parent conversation context a
 * worker receives. Full transcripts are never an implicit default.
 */
export const WorkflowContextPolicy = Schema.Literals(["none", "summary", "selected-messages"]);
export type WorkflowContextPolicy = typeof WorkflowContextPolicy.Type;

export const WorkflowContextMessage = Schema.Struct({
  messageId: MessageId,
  role: Schema.Literals(["user", "assistant", "system"]),
  text: Schema.String,
  createdAt: IsoDateTime,
});
export type WorkflowContextMessage = typeof WorkflowContextMessage.Type;

export const WorkflowInputArtifact = Schema.Struct({
  kind: Schema.Literal("input-context"),
  contextPolicy: WorkflowContextPolicy,
  parentThreadId: ThreadId,
  messages: Schema.Array(WorkflowContextMessage),
  summary: Schema.optional(TrimmedNonEmptyString),
  truncated: Schema.Boolean,
});
export type WorkflowInputArtifact = typeof WorkflowInputArtifact.Type;

export const WorkflowEvidence = Schema.Struct({
  label: TrimmedNonEmptyString,
  threadId: Schema.optional(ThreadId),
  messageId: Schema.optional(MessageId),
});
export type WorkflowEvidence = typeof WorkflowEvidence.Type;

export const WorkflowWorkerResultArtifact = Schema.Struct({
  kind: Schema.Literal("worker-result"),
  status: Schema.Literals(["completed", "failed"]),
  summary: TrimmedNonEmptyString,
  body: Schema.String,
  evidence: Schema.Array(WorkflowEvidence),
  changedPaths: Schema.Array(TrimmedNonEmptyString),
});
export type WorkflowWorkerResultArtifact = typeof WorkflowWorkerResultArtifact.Type;

export const WorkflowFinalResultArtifact = Schema.Struct({
  kind: Schema.Literal("final-result"),
  summary: TrimmedNonEmptyString,
  body: Schema.String,
  evidence: Schema.Array(WorkflowEvidence),
});
export type WorkflowFinalResultArtifact = typeof WorkflowFinalResultArtifact.Type;

export const WorkflowArtifactPayload = Schema.Union([
  WorkflowInputArtifact,
  WorkflowWorkerResultArtifact,
  WorkflowFinalResultArtifact,
]);
export type WorkflowArtifactPayload = typeof WorkflowArtifactPayload.Type;

export const WorkflowArtifact = Schema.Struct({
  id: WorkflowArtifactId,
  runId: WorkflowRunId,
  nodeId: Schema.optional(WorkflowNodeId),
  producerThreadId: Schema.optional(ThreadId),
  payload: WorkflowArtifactPayload,
  createdAt: IsoDateTime,
});
export type WorkflowArtifact = typeof WorkflowArtifact.Type;

export const WorkflowNodeStatus = Schema.Literals([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export type WorkflowNodeStatus = typeof WorkflowNodeStatus.Type;

export const WorkflowNodeDefinition = Schema.Struct({
  id: WorkflowNodeId,
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  contextPolicy: WorkflowContextPolicy,
});
export type WorkflowNodeDefinition = typeof WorkflowNodeDefinition.Type;

export const WorkflowDefinition = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  nodes: Schema.Array(WorkflowNodeDefinition),
});
export type WorkflowDefinition = typeof WorkflowDefinition.Type;

export const WorkflowRunStatus = Schema.Literals([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export type WorkflowRunStatus = typeof WorkflowRunStatus.Type;

export const WorkflowNodeRun = Schema.Struct({
  nodeId: WorkflowNodeId,
  status: WorkflowNodeStatus,
  workerThreadId: Schema.optional(ThreadId),
  inputArtifactId: Schema.optional(WorkflowArtifactId),
  resultArtifactId: Schema.optional(WorkflowArtifactId),
  startedAt: Schema.optional(IsoDateTime),
  completedAt: Schema.optional(IsoDateTime),
});
export type WorkflowNodeRun = typeof WorkflowNodeRun.Type;

export const WorkflowRun = Schema.Struct({
  id: WorkflowRunId,
  workflowId: TrimmedNonEmptyString,
  parentThreadId: ThreadId,
  status: WorkflowRunStatus,
  nodes: Schema.Array(WorkflowNodeRun),
  finalArtifactId: Schema.optional(WorkflowArtifactId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  completedAt: Schema.optional(IsoDateTime),
});
export type WorkflowRun = typeof WorkflowRun.Type;

export const WorkflowRunSource = Schema.Struct({
  kind: Schema.Literal("workflow"),
  workflowId: TrimmedNonEmptyString,
  runId: WorkflowRunId,
  trigger: AgentWorkflowTrigger,
});
export type WorkflowRunSource = typeof WorkflowRunSource.Type;

export const WorkflowSkipReason = Schema.Literals([
  "workflow-disabled",
  "workflow-not-found",
  "thread-not-found",
  "project-not-found",
  "no-reviewable-changes",
  "automation-cooldown",
  "automation-run-limit",
  "workflow-origin",
]);
export type WorkflowSkipReason = typeof WorkflowSkipReason.Type;

export const WorkflowRunResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("started"),
    runId: WorkflowRunId,
    threadId: ThreadId,
    commandId: CommandId,
    messageId: MessageId,
    sequence: Schema.Number,
    createdAt: IsoDateTime,
  }),
  Schema.Struct({
    status: Schema.Literal("skipped"),
    runId: WorkflowRunId,
    reason: WorkflowSkipReason,
    message: TrimmedNonEmptyString,
    createdAt: IsoDateTime,
  }),
]);
export type WorkflowRunResult = typeof WorkflowRunResult.Type;

export const WorkflowLaunchStatus = Schema.Literals(["started", "skipped", "failed"]);
export type WorkflowLaunchStatus = typeof WorkflowLaunchStatus.Type;

export const WorkflowRunRecord = Schema.Struct({
  runId: WorkflowRunId,
  workflowId: TrimmedNonEmptyString,
  workflowName: TrimmedNonEmptyString,
  status: WorkflowLaunchStatus,
  trigger: AgentWorkflowTrigger,
  requestedThreadId: ThreadId,
  targetThreadId: Schema.optional(ThreadId),
  commandId: Schema.optional(CommandId),
  messageId: Schema.optional(MessageId),
  skipReason: Schema.optional(WorkflowSkipReason),
  message: Schema.optional(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  completedAt: Schema.optional(IsoDateTime),
});
export type WorkflowRunRecord = typeof WorkflowRunRecord.Type;

export const WorkflowListRunsInput = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  limit: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(50))),
});
export type WorkflowListRunsInput = typeof WorkflowListRunsInput.Type;

export const WorkflowListRunsResult = Schema.Struct({
  runs: Schema.Array(WorkflowRunRecord),
});
export type WorkflowListRunsResult = typeof WorkflowListRunsResult.Type;

export class WorkflowRunError extends Schema.TaggedErrorClass<WorkflowRunError>()(
  "WorkflowRunError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Unknown),
  },
) {}
