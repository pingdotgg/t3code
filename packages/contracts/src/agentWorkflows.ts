import { Effect } from "effect";
import * as Schema from "effect/Schema";
import {
  CommandId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection, ProviderInteractionMode, RuntimeMode } from "./orchestration.ts";

export const ReviewChangesScope = Schema.Literals(["uncommitted", "against-base"]);
export type ReviewChangesScope = typeof ReviewChangesScope.Type;

export const DEFAULT_REVIEW_CHANGES_SCOPE: ReviewChangesScope = "uncommitted";

export const DEFAULT_REVIEW_CHANGES_PROMPT_TEMPLATE = `Act as a code reviewer, focusing on newly introduced, discrete, actionable defects.
Prioritize correctness, performance, security, reliability, and maintainability.
Avoid speculative, stylistic, or low-signal feedback.
Verify concerns using surrounding code and tests where useful.
Report findings concisely in normal Markdown.
State briefly if no actionable issues are found.
Follow repository rules, including using bun run test rather than bun test; code changes would additionally require bun fmt, bun lint, and bun typecheck.
Use the code-review skill's systematic review workflow.`;

export const ReviewChangesWorkflowSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  defaultScope: ReviewChangesScope.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_REVIEW_CHANGES_SCOPE)),
  ),
  promptTemplate: Schema.String.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_REVIEW_CHANGES_PROMPT_TEMPLATE)),
  ),
});
export type ReviewChangesWorkflowSettings = typeof ReviewChangesWorkflowSettings.Type;

export const AgentWorkflowTrigger = Schema.Literals(["manual", "after-assistant-turn-completes"]);
export type AgentWorkflowTrigger = typeof AgentWorkflowTrigger.Type;

export const DEFAULT_AGENT_WORKFLOW_AUTOMATION_COOLDOWN_MS = 5 * 60 * 1000;
export const DEFAULT_AGENT_WORKFLOW_MAX_RUNS_PER_THREAD = 1;

export const CustomAgentWorkflowAutomationSettings = Schema.Struct({
  afterAssistantTurnCompletes: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  cooldownMs: NonNegativeInt.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_AGENT_WORKFLOW_AUTOMATION_COOLDOWN_MS)),
  ),
  maxRunsPerThread: NonNegativeInt.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_AGENT_WORKFLOW_MAX_RUNS_PER_THREAD)),
  ),
});
export type CustomAgentWorkflowAutomationSettings =
  typeof CustomAgentWorkflowAutomationSettings.Type;

export const AgentWorkflowDestinationMode = Schema.Literals([
  "same-chat",
  "new-chat",
  "child-chat",
]);
export type AgentWorkflowDestinationMode = typeof AgentWorkflowDestinationMode.Type;

export const AgentWorkflowSettings = Schema.Struct({
  reviewChanges: ReviewChangesWorkflowSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  builtInOverrides: Schema.Record(
    TrimmedNonEmptyString,
    Schema.Struct({
      enabled: Schema.optionalKey(Schema.Boolean),
      promptTemplate: Schema.optionalKey(Schema.String),
      defaultInput: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  customWorkflows: Schema.Array(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
      name: TrimmedNonEmptyString,
      buttonLabel: TrimmedNonEmptyString,
      promptTemplate: Schema.String,
      showInHeader: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
      destinationMode: AgentWorkflowDestinationMode.pipe(
        Schema.withDecodingDefault(Effect.succeed("child-chat" as const)),
      ),
      automation: CustomAgentWorkflowAutomationSettings.pipe(
        Schema.withDecodingDefault(Effect.succeed({})),
      ),
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type AgentWorkflowSettings = typeof AgentWorkflowSettings.Type;

export const WorkflowRunId = TrimmedNonEmptyString.pipe(Schema.brand("WorkflowRunId"));
export type WorkflowRunId = typeof WorkflowRunId.Type;

export const WorkflowRunSource = Schema.Struct({
  kind: Schema.Literal("workflow"),
  workflowId: TrimmedNonEmptyString,
  runId: WorkflowRunId,
  trigger: AgentWorkflowTrigger,
});
export type WorkflowRunSource = typeof WorkflowRunSource.Type;

export const WorkflowRunInput = Schema.Struct({
  workflowId: TrimmedNonEmptyString,
  threadId: ThreadId,
  projectId: Schema.optional(ProjectId),
  cwd: Schema.optional(TrimmedNonEmptyString),
  input: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  destinationMode: Schema.optional(AgentWorkflowDestinationMode),
  title: Schema.optional(TrimmedNonEmptyString),
  trigger: AgentWorkflowTrigger.pipe(Schema.withDecodingDefault(Effect.succeed("manual" as const))),
  idempotencyKey: TrimmedNonEmptyString,
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
});
export type WorkflowRunInput = typeof WorkflowRunInput.Type;

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

export const WorkflowRunStatus = Schema.Literals(["started", "skipped", "failed"]);
export type WorkflowRunStatus = typeof WorkflowRunStatus.Type;

export const WorkflowRunRecord = Schema.Struct({
  runId: WorkflowRunId,
  workflowId: TrimmedNonEmptyString,
  workflowName: TrimmedNonEmptyString,
  status: WorkflowRunStatus,
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
