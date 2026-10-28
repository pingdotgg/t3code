import * as Schema from "effect/Schema";

import {
  CommandId,
  ForwardCompatibleArray,
  IsoDateTime,
  NonNegativeInt,
  PipelineId,
  PipelineRunId,
  PipelineStepId,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "./chatAttachment.ts";
import { ModelSelection } from "./modelSelection.ts";
import {
  OrchestrationV2Actor,
  OrchestrationV2CreationSource,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
} from "./orchestrationV2.ts";
import { RuntimeMode } from "./providerPolicy.ts";

export const PIPELINE_MAX_STEPS = 12;
export const PIPELINE_OUTPUT_PREVIEW_CHARS = 2_000;

/** The name part of a `$skill` mention, as the composer parses it. */
const PipelineSkillName = TrimmedNonEmptyString.check(
  Schema.isPattern(/^(?=[a-zA-Z0-9:_-]*[a-zA-Z])[a-zA-Z0-9][a-zA-Z0-9:_-]*$/),
);

export const PipelineStep = Schema.Struct({
  id: PipelineStepId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  skills: Schema.Array(PipelineSkillName).check(Schema.isMaxLength(8)),
  promptTemplate: TrimmedNonEmptyString,
  pauseBefore: Schema.Boolean,
});
export type PipelineStep = typeof PipelineStep.Type;

export type PipelineTemplateReference =
  | { readonly kind: "input" }
  | { readonly kind: "previous" }
  | { readonly kind: "step"; readonly key: string }
  | { readonly kind: "unknown"; readonly expression: string };

export interface PipelineTemplateIssue {
  readonly stepId: string;
  readonly message: string;
}

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const STEP_OUTPUT_EXPRESSION = /^steps\.(.+)\.output$/;

export function pipelineTemplateReferences(
  template: string,
): ReadonlyArray<PipelineTemplateReference> {
  return [...template.matchAll(PLACEHOLDER)].map((match): PipelineTemplateReference => {
    const expression = (match[1] ?? "").trim();
    if (expression === "input") return { kind: "input" };
    if (expression === "previous.output") return { kind: "previous" };
    const key = STEP_OUTPUT_EXPRESSION.exec(expression)?.[1]?.trim();
    return key ? { kind: "step", key } : { kind: "unknown", expression };
  });
}

/**
 * Matches the step id first, then the name ignoring case and surrounding space; -1 when none match.
 * Takes plain strings so editors can validate drafts before ids are branded.
 */
export function resolvePipelineStepKey(
  steps: ReadonlyArray<{ readonly id: string; readonly name: string }>,
  key: string,
): number {
  const trimmed = key.trim();
  const byId = steps.findIndex((step) => step.id === trimmed);
  if (byId !== -1) return byId;
  const lowered = trimmed.toLowerCase();
  return steps.findIndex((step) => step.name.trim().toLowerCase() === lowered);
}

/** OpenCode-style `agent: plan` is plan mode under another name, and pipelines have none. */
const isPlanAgentOption = (option: { readonly id: string; readonly value: unknown }) =>
  option.id === "agent" && option.value === "plan";

export function pipelineDefinitionIssues(
  steps: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly promptTemplate: string;
    readonly modelSelection?: {
      readonly options?: ReadonlyArray<{ readonly id: string; readonly value: unknown }>;
    } | null;
  }>,
): ReadonlyArray<PipelineTemplateIssue> {
  const issues: PipelineTemplateIssue[] = [];
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  steps.forEach((step, index) => {
    if (seenIds.has(step.id)) {
      issues.push({ stepId: step.id, message: `Step id "${step.id}" is used more than once.` });
    }
    seenIds.add(step.id);
    const name = step.name.trim().toLowerCase();
    if (seenNames.has(name)) {
      issues.push({ stepId: step.id, message: `Step name "${step.name}" is used more than once.` });
    }
    seenNames.add(name);
    if (step.modelSelection?.options?.some(isPlanAgentOption)) {
      issues.push({
        stepId: step.id,
        message: `Step "${step.name}" uses the plan agent; pipelines have no plan mode.`,
      });
    }

    for (const reference of pipelineTemplateReferences(step.promptTemplate)) {
      if (reference.kind === "unknown") {
        issues.push({
          stepId: step.id,
          message: `Step "${step.name}" uses unknown variable {{${reference.expression}}}.`,
        });
      } else if (reference.kind === "previous" && index === 0) {
        issues.push({
          stepId: step.id,
          message: `Step "${step.name}" is first, so {{previous.output}} has nothing to read.`,
        });
      } else if (reference.kind === "step") {
        const target = resolvePipelineStepKey(steps, reference.key);
        if (target === -1) {
          issues.push({
            stepId: step.id,
            message: `Step "${step.name}" refers to "${reference.key}", which is not a step.`,
          });
        } else if (target >= index) {
          issues.push({
            stepId: step.id,
            message: `Step "${step.name}" refers to "${reference.key}", which does not run before it.`,
          });
        }
      }
    }
  });
  return issues;
}

const PipelineName = TrimmedNonEmptyString.check(Schema.isMaxLength(80));

const PipelineSteps = Schema.Array(PipelineStep)
  .check(Schema.isMinLength(1), Schema.isMaxLength(PIPELINE_MAX_STEPS))
  .check(Schema.makeFilter((steps) => pipelineDefinitionIssues(steps)[0]?.message ?? true));

export const PipelineDefinition = Schema.Struct({
  id: PipelineId,
  name: PipelineName,
  steps: PipelineSteps,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type PipelineDefinition = typeof PipelineDefinition.Type;

/** Without the steps filter: a stored run must keep decoding after the rules change. */
export const PipelineSnapshot = Schema.Struct({
  name: PipelineName,
  steps: Schema.Array(PipelineStep),
});
export type PipelineSnapshot = typeof PipelineSnapshot.Type;

export const PipelineListInput = Schema.Struct({});
export type PipelineListInput = typeof PipelineListInput.Type;

export const PipelineListResult = Schema.Struct({
  pipelines: ForwardCompatibleArray(PipelineDefinition),
});
export type PipelineListResult = typeof PipelineListResult.Type;

export const PipelineUpsertInput = Schema.Struct({
  id: Schema.optional(PipelineId),
  requireExisting: Schema.optional(Schema.Boolean).annotate({
    description: "Reject the save if the pipeline no longer exists, for edits from a client form.",
  }),
  commandId: Schema.optional(CommandId),
  name: PipelineName,
  steps: PipelineSteps,
});
export type PipelineUpsertInput = typeof PipelineUpsertInput.Type;

export const PipelineMutationResult = Schema.Struct({ pipeline: PipelineDefinition });
export type PipelineMutationResult = typeof PipelineMutationResult.Type;

export const PipelineDeleteInput = Schema.Struct({ id: PipelineId });
export type PipelineDeleteInput = typeof PipelineDeleteInput.Type;

export const PipelineDeleteResult = Schema.Struct({ id: PipelineId });
export type PipelineDeleteResult = typeof PipelineDeleteResult.Type;

export const PipelineRunStatus = Schema.Literals(["running", "paused", "completed", "cancelled"]);
export type PipelineRunStatus = typeof PipelineRunStatus.Type;

export const PipelinePauseReason = Schema.Literals([
  "awaiting_continue",
  "step_failed",
  "step_stopped",
]);
export type PipelinePauseReason = typeof PipelinePauseReason.Type;

export const PipelineRunStepStatus = Schema.Literals([
  "pending",
  "running",
  "completed",
  "failed",
  "stopped",
  "skipped",
  "cancelled",
]);
export type PipelineRunStepStatus = typeof PipelineRunStepStatus.Type;

export const PipelineRunStep = Schema.Struct({
  index: NonNegativeInt,
  stepId: PipelineStepId,
  status: PipelineRunStepStatus,
  attempt: NonNegativeInt.annotate({ description: "0 until the step is first launched." }),
  childThreadId: Schema.NullOr(ThreadId).annotate({ description: "Thread of the latest attempt." }),
  pauseBefore: Schema.Boolean.annotate({
    description: "Run-level override, initialised from the snapshot.",
  }),
  outputPreview: Schema.NullOr(Schema.String).annotate({
    description: `At most ${PIPELINE_OUTPUT_PREVIEW_CHARS} characters; the full output stays on the server.`,
  }),
  error: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
});
export type PipelineRunStep = typeof PipelineRunStep.Type;

export const PipelineRun = Schema.Struct({
  id: PipelineRunId,
  pipelineId: Schema.NullOr(PipelineId),
  definition: PipelineSnapshot,
  projectId: ProjectId,
  parentThreadId: ThreadId,
  input: Schema.String,
  workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
  status: PipelineRunStatus,
  pauseReason: Schema.NullOr(PipelinePauseReason),
  error: Schema.NullOr(Schema.String),
  currentStepIndex: NonNegativeInt,
  steps: Schema.Array(PipelineRunStep),
  createdBy: OrchestrationV2Actor,
  creationSource: OrchestrationV2CreationSource,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
});
export type PipelineRun = typeof PipelineRun.Type;

export const PipelineRunStartInput = Schema.Struct({
  commandId: Schema.optional(CommandId),
  pipelineId: PipelineId,
  projectId: ProjectId,
  input: TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
  creationSource: Schema.optional(OrchestrationV2CreationSource),
});
export type PipelineRunStartInput = typeof PipelineRunStartInput.Type;

export const PipelineRunSubscribeInput = Schema.Struct({ runId: PipelineRunId });
export type PipelineRunSubscribeInput = typeof PipelineRunSubscribeInput.Type;

/** Shared by continue, retryStep and skipStep; the server rejects a stale `stepIndex`. */
export const PipelineRunStepActionInput = Schema.Struct({
  runId: PipelineRunId,
  stepIndex: NonNegativeInt,
});
export type PipelineRunStepActionInput = typeof PipelineRunStepActionInput.Type;

export const PipelineRunCancelInput = Schema.Struct({ runId: PipelineRunId });
export type PipelineRunCancelInput = typeof PipelineRunCancelInput.Type;

export const PipelineRunSetPauseBeforeInput = Schema.Struct({
  runId: PipelineRunId,
  stepId: PipelineStepId,
  pauseBefore: Schema.Boolean,
});
export type PipelineRunSetPauseBeforeInput = typeof PipelineRunSetPauseBeforeInput.Type;

export const PipelineRunResult = Schema.Struct({ run: PipelineRun });
export type PipelineRunResult = typeof PipelineRunResult.Type;

export class PipelineError extends Schema.TaggedError<PipelineError>()("PipelineError", {
  message: Schema.String,
  pipelineId: Schema.optional(PipelineId),
  runId: Schema.optional(PipelineRunId),
  cause: Schema.optional(Schema.Defect()),
}) {}
