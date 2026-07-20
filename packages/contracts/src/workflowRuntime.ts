import { Effect, Schema } from "effect";

import {
  AgentWorkflowDestinationMode,
  AgentWorkflowTrigger,
  DEFAULT_REVIEW_CHANGES_SCOPE,
  ReviewChangesScope,
} from "./agentWorkflows.ts";
import { NonNegativeInt, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection, ProviderInteractionMode, RuntimeMode } from "./orchestration.ts";

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
  modelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  defaultScope: ReviewChangesScope.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_REVIEW_CHANGES_SCOPE)),
  ),
  promptTemplate: Schema.String.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_REVIEW_CHANGES_PROMPT_TEMPLATE)),
  ),
});
export type ReviewChangesWorkflowSettings = typeof ReviewChangesWorkflowSettings.Type;

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
      modelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
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

/**
 * Transport-facing workflow launch input. Runtime provider settings live here
 * so the durable workflow domain schemas can be imported by orchestration
 * without a module cycle.
 */
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
